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
const genericPool = require('generic-pool');
const Bull = require('bull');

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  const numCPUs = os.cpus().length;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  const app = express();
  const port = process.env.PORT || 3000;

  // Redis client setup
  const redisClient = new Redis({
    host: process.env.REDIS_HOST || 'redis-15623.c326.us-east-1-3.ec2.redns.redis-cloud.com',
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
  const cache = new NodeCache({ stdTTL: 3600 });

  app.use(express.json());
  app.use(compression());
  app.use(helmet());

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
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

  // Create a pool of LinkedIn scrapers
  const scraperPool = genericPool.createPool({
    create: async () => {
      const scraper = new LinkedinScraper({
        headless: true,
        slowMo: 200,
        args: ["--lang=en-GB", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
      return scraper;
    },
    destroy: async (scraper) => {
      await scraper.close();
    }
  }, {
    max: 5,
    min: 2
  });

  // Create a Bull queue for scraping jobs
  const scrapeQueue = new Bull('scrape-jobs', {
    redis: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
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
          delay *= 2;
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

  async function runScraper(scraper, query, locations, limit, filters, existingJobIds) {
    return new Promise((resolve, reject) => {
      const results = [];
      const fetchedJobIds = new Set(existingJobIds);
      let jobCount = 0;

      scraper.on(events.scraper.data, (data) => {
        if (jobCount >= limit || fetchedJobIds.has(data.jobId)) return;
        jobCount++;
        fetchedJobIds.add(data.jobId);
        results.push(data);
      });

      scraper.on(events.scraper.error, (err) => {
        reject(err);
      });

      scraper.on(events.scraper.end, () => {
        resolve(results);
      });

      const mappedFilters = {
        relevance: relevanceFilter.RELEVANT,
        time: timeFilter.ANY,
        type: filters.type,
        experience: filters.experience,
        onSiteOrRemote: filters.onSiteOrRemote ? filters.onSiteOrRemote.map(o => onSiteOrRemoteFilter[o]) : undefined,
      };

      scraper.run([{
        query,
        options: {
          locations,
          filters: mappedFilters,
          optimize: true,
          limit: limit * 2,
        },
      }], {
        paginationMax: 5,
        delay: () => Math.floor(Math.random() * 1000) + 500,
        userAgent: () => userAgents[Math.floor(Math.random() * userAgents.length)],
      });
    });
  }

  // Process scraping jobs
  scrapeQueue.process(async (job) => {
    const { query, locations, limit, filters, existingJobIds } = job.data;
    const scraper = await scraperPool.acquire();
    
    try {
      const results = await runScraper(scraper, query, locations, limit, filters, existingJobIds);
      await scraperPool.release(scraper);
      return results;
    } catch (error) {
      await scraperPool.release(scraper);
      throw error;
    }
  });

  app.post('/scrape', async (req, res) => {
    const { query, locations, limit, options, existingJobIds } = req.body;
    const filters = options.filters;

    logger.info('Received API request:', { query, locations, limit, filters, existingJobIds: existingJobIds.length });

    const cacheKey = `${query}-${locations.join(',')}-${limit}-${JSON.stringify(filters)}-${existingJobIds.join(',')}`;

    try {
      const cachedResults = await redisClient.get(cacheKey);
      if (cachedResults) {
        logger.info('Returning cached results from Redis');
        return res.json(JSON.parse(cachedResults));
      }

      const job = await scrapeQueue.add({
        query,
        locations,
        limit,
        filters,
        existingJobIds
      });

      const results = await job.finished();

      const sortedResults = results.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

      const applyLinkPromises = sortedResults.map(job => fetchApplyLink(job));
      const applyLinks = await Promise.all(applyLinkPromises);

      sortedResults.forEach((job, index) => {
        job.applyLink = applyLinks[index] || "";
      });

      logger.info('Scraping completed successfully');

      await redisClient.set(cacheKey, JSON.stringify(sortedResults), 'EX', 3600);
      res.json(sortedResults);
    } catch (error) {
      logger.error('Error during scraping:', error);
      res.status(500).json({ error: 'An error occurred during scraping' });
    }
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
  });

  app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'An unexpected error occurred' });
  });

  app.use(expressWinston.errorLogger({
    winstonInstance: logger,
  }));

  app.listen(port, () => {
    logger.info(`Worker ${process.pid} is running on http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM signal received: closing HTTP server');
    await scraperPool.drain();
    await scraperPool.clear();
    await scrapeQueue.close();
    process.exit(0);
  });
}