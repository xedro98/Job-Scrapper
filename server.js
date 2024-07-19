const express = require('express');
const { LinkedinScraper, events, typeFilter } = require('linkedin-jobs-scraper');

const app = express();
const port = process.env.PORT || 3000; // Use the PORT environment variable

app.use(express.json());

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.181 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/66.0.3359.181 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.99 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36"
];

app.post('/scrape', async (req, res) => {
  const { query, locations, limit } = req.body;

  const scraper = new LinkedinScraper({
    headless: 'new',
    slowMo: 500, // Increased slowMo value to reduce request rate
    args: ["--lang=en-GB"],
  });

  let results = [];

  scraper.on(events.scraper.data, (data) => {
    // Only push relevant job details
    results.push({
      title: data.title,
      company: data.company,
      place: data.place,
      date: data.date,
      link: data.link,
      description: data.description
    });
  });

  scraper.on(events.scraper.error, (err) => {
    console.error(err);
  });

  scraper.on(events.scraper.end, () => {
    console.log('All done!');
  });

  try {
    // Run scraper with the provided query
    await scraper.run([{
      query,
      options: {
        locations,
        filters: {
          type: [typeFilter.FULL_TIME, typeFilter.CONTRACT],
        },
      },
    }], {
      locations,
      limit,
      // Adding random delay between requests to avoid detection
      delay: () => (Math.random() * 2000) + 1000, // Random delay between 1s to 3s
      // Rotate User-Agents
      userAgent: () => userAgents[Math.floor(Math.random() * userAgents.length)],
    });

    await scraper.close();
    
    // Send a nicely formatted JSON response
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(results, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});