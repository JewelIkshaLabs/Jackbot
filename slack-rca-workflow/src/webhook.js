import crypto from 'crypto';
import { processSlackEvent } from './job-processor.js';
import { WebClient } from '@slack/web-api';

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Verify Slack request signature
 */
function verifySlackSignature(req, signingSecret) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  
  // Get raw body (as Buffer or string)
  const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));

  if (!signature || !timestamp) {
    return false;
  }

  // Check if timestamp is too old (replay attack protection)
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
    return false;
  }

  // Create signature base string
  const sigBaseString = `v0:${timestamp}:${rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBaseString)
    .digest('hex');

  // Compare signatures using timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(mySignature)
    );
  } catch (error) {
    console.error('Signature comparison error:', error);
    return false;
  }
}

/**
 * Get parent message if the event is a thread reply
 */
async function getParentMessageIfThreadReply(evt) {
  // Check if the message is a thread reply
  debugger
  if (evt.thread_ts && evt.thread_ts !== evt.ts) {
    console.log('   Message is a thread reply, fetching parent message...');
    
    try {
      const response = await slackClient.conversations.replies({
        channel: evt.channel,
        ts: evt.thread_ts,
      });
      
      const parentMessage = response.messages?.[0];
      if (parentMessage?.text) {
        console.log('   Parent message text:', parentMessage.text);
        return parentMessage;
      }
    } catch (error) {
      console.error('   Error fetching parent message:', error.message);
    }
  }
  
  return null;
}




/**
 * Extract GitHub repository URL and issue description from Slack message text
 * Returns { githubRepo: string|null, issueDescription: string }
 */
function extractIssueAndRepo(text) {
  if (!text) return { githubRepo: null, issueDescription: '' };

  // Remove bot mention from text
  let cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  
  // Match GitHub URLs (various formats)
  const githubPatterns = [
    /https?:\/\/github\.com\/([\w\-\.]+)\/([\w\-\.]+)(?:\/.*)?/i,
    /github\.com\/([\w\-\.]+)\/([\w\-\.]+)(?:\/.*)?/i,
  ];

  let githubRepo = null;
  let issueDescription = cleanText;

  // Find GitHub repo URL
  for (const pattern of githubPatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      githubRepo = `https://github.com/${owner}/${repo}`;
      
      // Remove GitHub URL from issue description
      issueDescription = cleanText.replace(pattern, '').trim();
      break;
    }
  }

  // If no GitHub URL found, try simple owner/repo pattern
  if (!githubRepo) {
    const simplePattern = /([\w\-\.]+)\/([\w\-\.]+)/i;
    const simpleMatch = cleanText.match(simplePattern);
    if (simpleMatch && !simpleMatch[0].includes('://') && !simpleMatch[0].includes('@')) {
      githubRepo = `https://github.com/${simpleMatch[1]}/${simpleMatch[2]}`;
      issueDescription = cleanText.replace(simplePattern, '').trim();
    }
  }

  // Clean up issue description - remove extra whitespace and common words
  issueDescription = issueDescription
    .replace(/\s+/g, ' ')
    .replace(/^(analyze|check|review|look at|examine)\s*/i, '')
    .trim();

  // If issue description is empty or just whitespace, use a default
  if (!issueDescription || issueDescription.length < 3) {
    issueDescription = githubRepo 
      ? `Analyze repository: ${githubRepo}` 
      : 'Issue reported from Slack';
  }

  return { githubRepo, issueDescription };
}

/**
 * Slack webhook handler
 */
export async function webhookHandler(req, res) {
  try {
    // Handle URL verification challenge
    if (req.body?.type === 'url_verification') {
      console.log('Slack URL verification challenge received');
      return res.status(200).send(req.body.challenge);
    }

    // Verify Slack signature (if signing secret is provided)
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (signingSecret) {
      if (!verifySlackSignature(req, signingSecret)) {
        console.error('Invalid Slack signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else {
      console.warn('SLACK_SIGNING_SECRET not set - skipping signature verification (not recommended for production)');
    }

    // Handle event callbacks
    if (req.body?.type === 'event_callback') {
      const event = req.body.event;

      // Only process app_mention events
      if (event.type === 'app_mention') {
        console.log('\n' + '='.repeat(80));
        console.log('📨 SLACK EVENT RECEIVED - App Mention');
        console.log('='.repeat(80));
        console.log(`   User: ${event.user}`);
        console.log(`   Channel: ${event.channel}`);
        console.log(`   Timestamp: ${event.ts}`);
        console.log(`   Thread Timestamp: ${event.thread_ts || 'none (not a thread)'}`);
        console.log(`   Message: ${event.text || '(empty)'}`);
        console.log(`   Event Time: ${new Date().toISOString()}`);
        console.log('-'.repeat(80));

        // Check if this is a thread reply and get parent message
        const parentMessage = await getParentMessageIfThreadReply(event);
        let messageToAnalyze = event.text;
        
        if (parentMessage) {
          console.log('   📧 Bot mentioned in thread - using parent message as context');
          // Use parent message as the main issue description
          messageToAnalyze = parentMessage.text;
          console.log(`   Parent message: ${messageToAnalyze.substring(0, 200)}...`);
        }
        
        // Extract issue description and GitHub repo from message
        console.log('   Extracting issue and repository from message...');
        const { githubRepo, issueDescription } = extractIssueAndRepo(messageToAnalyze);
        
        // Check if repo is provided in message or environment
        // Use BACKEND_REPO_URL as default if GITHUB_REPO is not set
        const envRepo = process.env.GITHUB_REPO || process.env.BACKEND_REPO_URL || null;
        const finalRepo = githubRepo || envRepo;
        
        console.log(`   Issue extracted: ${issueDescription}`);
        console.log(`   Repo in message: ${githubRepo || 'none'}`);
        console.log(`   Repo in env: ${envRepo || 'none'}`);
        console.log(`   Final repo: ${finalRepo || 'MISSING'}`);
        
        // Log if repo is missing
        if (!finalRepo) {
          console.warn('⚠️ GitHub repository not provided:', {
            inMessage: !!githubRepo,
            inEnv: !!envRepo,
            messageText: event.text,
            issueDescription: issueDescription,
            timestamp: new Date().toISOString(),
          });
        } else if (!githubRepo && envRepo) {
          console.log('ℹ️ Using GitHub repository from environment');
        }
        
        if (!finalRepo) {
          // Reply to user that they need to provide a GitHub repo
          // This will be handled asynchronously
          processSlackEvent(event, null, issueDescription).catch(err => {
            console.error('Error processing event:', err);
          });
        } else {
          // Process the event asynchronously with both repo and issue
          processSlackEvent(event, finalRepo, issueDescription).catch(err => {
            console.error('Error processing event:', err);
          });
        }

        // Respond immediately to Slack (within 3 seconds)
        return res.status(200).json({ ok: true });
      }

      // Ignore other event types
      console.log('Ignoring non-app_mention event:', event.type);
      return res.status(200).json({ ok: true });
    }

    // Unknown event type
    console.log('Unknown event type:', req.body?.type);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

