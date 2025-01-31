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

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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
        console.log(`Rate limited on attempt ${attempt + 1} for ${jobData.link}. Retrying in ${delay / 1000} seconds...`);
        await sleep(delay);
        delay *= 2; // Exponential backoff
      } else {
        console.error(`Error fetching apply link for ${jobData.link}:`, error.message);
        return null;
      }
    }
  }
  console.error(`Failed to fetch apply link for ${jobData.link} after ${retries} attempts`);
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
    console.error('Error parsing URL:', error);
  }
  return linkedInUrl;
}

app.post('/scrape', async (req, res) => {
  const { query, locations, limit, options, existingJobIds } = req.body;
  const filters = options.filters;

  console.log('Received API request:', { query, locations, limit, filters, existingJobIds: existingJobIds.length });

  const maxRetries = 6;
  let currentRetry = 0;
  let results = [];
  let responsesSent = false;

  const runScraper = async () => {
    await sleep(5000); // Wait for 5 seconds before starting the scraper

    const scraper = new LinkedinScraper({
      headless: true,
      slowMo: 300,
      args: ["--lang=en-GB", "--no-sandbox", "--disable-setuid-sandbox"],
    });

    const fetchedJobIds = new Set(existingJobIds);
    let jobCount = 0;

    scraper.on(events.scraper.data, async (data) => {
      if (responsesSent || jobCount >= limit) return;
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

      console.log(`Job ID: ${data.jobId}, Title: ${data.title}`);

      if (results.length >= limit) {
        await scraper.close();
        await sendResponse();
      }
    });

    scraper.on(events.scraper.error, (err) => {
      console.error('Scraper error:', err);
    });

    scraper.on(events.scraper.end, async () => {
      console.log('Scraping attempt completed');
      if (!responsesSent) {
        await sendResponse();
      }
    });

    try {
      const mappedFilters = {
        relevance: relevanceFilter.RELEVANT,
        time: timeFilter.ANY,
        type: filters.type,
        experience: filters.experience,
        onSiteOrRemote: filters.onSiteOrRemote ? filters.onSiteOrRemote.map(o => onSiteOrRemoteFilter[o]) : undefined,
      };

      console.log('Running scraper with options:', { query, locations, filters: mappedFilters, limit });

      await sleep(5000);

      await scraper.run([{
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
      });

      await scraper.close();

      if (!responsesSent) {
        await sendResponse();
      }
    } catch (error) {
      console.error('Error during scraping:', error);
      await scraper.close();
      throw error;
    }
  };

  const sendResponse = async () => {
    if (responsesSent) return;
    responsesSent = true;

    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    results = results.slice(0, limit);

    const applyLinkPromises = results.map(job => fetchApplyLink(job));
    const applyLinks = await Promise.all(applyLinkPromises);

    results.forEach((job, index) => {
      job.applyLink = applyLinks[index] || "";
    });

    console.log('Scraping completed successfully');
    res.json(results);
  };

  const attemptScrape = async () => {
    try {
      await runScraper();
    } catch (error) {
      console.error('Error during scraping:', error);
      if (currentRetry < maxRetries && !responsesSent) {
        currentRetry++;
        console.log(`Retrying scrape attempt ${currentRetry} of ${maxRetries}`);
        await sleep(5000 * currentRetry);
        await attemptScrape();
      } else if (!responsesSent) {
        console.error('Max retries reached or error after response sent. Sending error response.');
        res.status(500).json({ error: 'Failed to scrape after multiple attempts' });
      }
    }
  };

  attemptScrape();
});
 
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});