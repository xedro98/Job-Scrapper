require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { promisify } = require('util');
const sleep = promisify(setTimeout);
const {
  LinkedinScraper,
  events,
  relevanceFilter,
  timeFilter,
  experienceLevelFilter,
  onSiteOrRemoteFilter,
} = require('linkedin-jobs-scraper');
const NodeCache = require('node-cache');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const winston = require('winston');
const expressWinston = require('express-winston');
const cluster = require('cluster');
const os = require('os');

// Check if this is the master process
if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers
  const numCPUs = os.cpus().length;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    // Replace the dead worker
    cluster.fork();
  });
} else {
  // This is a worker process

  const app = express();
  const port = process.env.PORT || 3000;

  // Redis client setup
  const redisClient = new Redis({
    host: process.env.REDIS_HOST || 'redis-15623.c326.us-east-1-3.ec2.redns.redns.redis-cloud.com',
    port: process.env.REDIS_PORT || 15623,
    password: process.env.REDIS_PASSWORD || 'ro5b7WjPEwm2voU95vWz6T8pZPyRlErf',
  });

  redisClient.on('error', (err) => console.log('Redis Client Error', err));
  redisClient.on('connect', () => console.log('Connected to Redis'));

  // Winston logger setup
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    defaultMeta: { service: 'linkedin-scraper' },
    transports: [
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
      new winston.transports.File({ filename: 'combined.log' }),
    ],
  });

  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: winston.format.simple(),
    }));
  }

  // Express-winston logger
  app.use(expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
    colorize: false,
  }));

  // Initialize cache
  const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

  app.use(express.json());
  app.use(compression()); // Add compression middleware
  app.use(helmet()); // Add Helmet middleware for security headers

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59"
  ];

  const axiosInstance = axios.create({
    timeout: 10000,
    headers: {
      'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)]
    }
  });

  async function fetchApplyLink(jobData, retries = 3, delay = 2000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await axiosInstance.get(jobData.link);
        const $ = cheerio.load(response.data);
        
        const applyUrlCode = $('code#applyUrl');
        if (applyUrlCode.length > 0) {
          const applyUrlContent = applyUrlCode.html();
          if (applyUrlContent) {
            const match = applyUrlContent.match(/<!--"(.+)"-->/);
            if (match && match[1]) {
              return extractExternalUrl(decodeURIComponent(match[1]));
            }
          }
        }
        
        const applyButton = $('a[data-tracking-control-name="public_jobs_apply-link-offsite"]');
        if (applyButton.length > 0) {
          return extractExternalUrl(applyButton.attr('href'));
        }
        
        const alternativeApplyButton = $('a[data-tracking-control-name="public_jobs_apply-link"]');
        if (alternativeApplyButton.length > 0) {
          return extractExternalUrl(alternativeApplyButton.attr('href'));
        }

        return null;
      } catch (error) {
        if (error.response && error.response.status === 429) {
          logger.warn(`Rate limited on attempt ${attempt + 1} for ${jobData.link}. Retrying in ${delay / 1000} seconds...`);
          await sleep(delay);
          delay *= 2; // Exponential backoff
        } else {
          logger.error(`Error fetching apply link for ${jobData.link}:`, error.message);
          return null;
        }
      }
    }
    logger.error(`Failed to fetch apply link for ${jobData.link} after ${retries} attempts`);
    return null;
  }

  function extractExternalUrl(linkedInUrl) {
    try {
      const parsedUrl = new URL(linkedInUrl);
      const externalUrl = parsedUrl.searchParams.get('url');
      if (externalUrl) {
        const cleanExternalUrl = new URL(externalUrl);
        cleanExternalUrl.searchParams.delete('refId');
        cleanExternalUrl.searchParams.delete('trackingId');
        return cleanExternalUrl.toString();
      }
    } catch (error) {
      logger.error('Error parsing URL:', error);
    }
    return linkedInUrl;
  }

  const MAX_RETRIES = 10;
  const MAX_RETRY_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds
  const RETRY_DELAY = 10000; // 10 seconds

  async function runScraperWithRetry(query, locations, filters, limit, existingJobIds) {
    const startTime = Date.now();
    let retryCount = 0;
    let results = [];

    while (retryCount < MAX_RETRIES && (Date.now() - startTime) < MAX_RETRY_TIME) {
      try {
        results = await runScraper(query, locations, filters, limit, existingJobIds);
        
        if (results.length > 0) {
          return results; // Successful scrape with results
        }
        
        logger.warn('Scraper completed but no results were found. Retrying...');
      } catch (error) {
        if (error.message.includes('Failed to load container selector')) {
          logger.warn('Failed to load container selector. Retrying...');
        } else {
          logger.error('Unexpected error during scraping:', error);
        }
      }

      retryCount++;
      await sleep(RETRY_DELAY);
    }

    throw new Error('Max retries or time exceeded without successful results');
  }

  async function runScraper(query, locations, filters, limit, existingJobIds) {
    await sleep(5000); // Wait for 5 seconds before starting the scraper

    const scraper = new LinkedinScraper({
      headless: true,
      slowMo: 200,
      args: ["--lang=en-GB", "--no-sandbox", "--disable-setuid-sandbox"],
    });

    const fetchedJobIds = new Set(existingJobIds);
    let jobCount = 0;
    let results = [];

    return new Promise((resolve, reject) => {
      scraper.on(events.scraper.data, async (data) => {
        if (jobCount >= limit) return;
        if (fetchedJobIds.has(data.jobId)) return;

        jobCount++;
        fetchedJobIds.add(data.jobId);

        const jobData = {
          jobId: data.jobId,
          title: data.title,
          company: data.company,
          companyLink: data.companyLink,
          companyImgLink: data.companyImgLink,
          place: data.place,
          date: data.date,
          link: data.link,
          seniorityLevel: data.seniorityLevel,
          jobFunction: data.jobFunction,
          employmentType: data.employmentType,
          description: data.description,
          descriptionHTML: data.descriptionHTML,
        };

        results.push(jobData);

        logger.info(`Job ID: ${data.jobId}, Title: ${data.title}`);

        if (results.length >= limit) {
          await scraper.close();
          resolve(results);
        }
      });

      scraper.on(events.scraper.error, (err) => {
        logger.error('Scraper error:', err);
        reject(err);
      });

      scraper.on(events.scraper.end, async () => {
        logger.info('Scraping attempt completed');
        resolve(results);
      });

      const mappedFilters = {
        relevance: relevanceFilter.RELEVANT,
        time: timeFilter.ANY,
        type: filters.type,
        experience: filters.experience,
        onSiteOrRemote: filters.onSiteOrRemote ? filters.onSiteOrRemote.map(o => onSiteOrRemoteFilter[o]) : undefined,
      };

      logger.info('Running scraper with options:', { query, locations, filters: mappedFilters, limit });

      scraper.run([{
        query,
        options: {
          locations,
          filters: mappedFilters,
          optimize: true,
          limit: limit * 2, // Set a higher limit to ensure we get enough results
        },
      }], {
        paginationMax: 5,
        delay: () => Math.floor(Math.random() * 1000) + 500,
        userAgent: () => userAgents[Math.floor(Math.random() * userAgents.length)],
      }).catch(reject);
    });
  }

  app.post('/scrape', async (req, res) => {
    const { query, locations, limit, options, existingJobIds } = req.body;
    const filters = options.filters;

    logger.info('Received API request:', { query, locations, limit, filters, existingJobIds: existingJobIds.length });

    // Generate cache key
    const cacheKey = `${query}-${locations.join(',')}-${limit}-${JSON.stringify(filters)}-${existingJobIds.join(',')}`;

    // Check Redis cache
    try {
      const cachedResults = await redisClient.get(cacheKey);
      if (cachedResults) {
        logger.info('Returning cached results from Redis');
        return res.json(JSON.parse(cachedResults));
      }
    } catch (error) {
      logger.error('Redis error:', error);
    }

    try {
      const results = await runScraperWithRetry(query, locations, filters, limit, existingJobIds);

      results.sort((a, b) => new Date(b.date) - new Date(a.date));
      const limitedResults = results.slice(0, limit);

      const applyLinkPromises = limitedResults.map(job => fetchApplyLink(job));
      const applyLinks = await Promise.all(applyLinkPromises);

      limitedResults.forEach((job, index) => {
        job.applyLink = applyLinks[index] || "";
      });

      logger.info('Scraping completed successfully');

      // Cache the results in Redis
      try {
        await redisClient.set(cacheKey, JSON.stringify(limitedResults), 'EX', 3600); // 1 hour expiration
      } catch (error) {
        logger.error('Redis caching error:', error);
      }

      res.json(limitedResults);
    } catch (error) {
      logger.error('Scraping failed after multiple retries:', error);
      res.status(500).json({ error: 'Failed to scrape after multiple attempts' });
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'An unexpected error occurred' });
  });

  // Express-winston error logger
  app.use(expressWinston.errorLogger({
    winstonInstance: logger,
  }));

  app.listen(port, () => {
    logger.info(`Worker ${process.pid} is running on http://localhost:${port}`);
  });
}