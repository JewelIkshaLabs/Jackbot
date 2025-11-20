import express from 'express';
import dotenv from 'dotenv';
import { webhookHandler } from './webhook.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Slack webhook endpoint with raw body parsing for signature verification
// MUST be defined BEFORE express.json() middleware
app.post('/webhook/slack', express.raw({ type: 'application/json' }), (req, res, next) => {
  try {
    // Store raw body for signature verification
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    req.rawBody = rawBody;
    
    // Parse JSON body for processing
    if (!rawBody || rawBody.length === 0) {
      console.error('Empty request body');
      return res.status(400).json({ error: 'Empty request body' });
    }
    
    req.body = JSON.parse(rawBody);
    console.log('Received webhook request:', {
      type: req.body?.type,
      eventType: req.body?.event?.type,
      hasChallenge: !!req.body?.challenge,
      bodyLength: rawBody.length,
    });
  } catch (error) {
    console.error('JSON parse error:', error.message);
    console.error('Raw body type:', typeof req.body, 'isBuffer:', Buffer.isBuffer(req.body));
    if (req.rawBody) {
      console.error('Raw body (first 500 chars):', req.rawBody.substring(0, 500));
    }
    return res.status(400).json({ error: 'Invalid JSON', details: error.message });
  }
  next();
}, webhookHandler);

// Middleware for other routes (after webhook route)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/slack`);
  console.log(`Repository location: /app/repo (cloned during Docker build)`);
});

