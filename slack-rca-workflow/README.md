# Slack Bot → Jira Ticket → RCA Workflow

A Dockerized Slack bot that receives app mention events, analyzes GitHub repositories, creates Jira tickets, and performs automated Root Cause Analysis (RCA) using OpenAI.

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- `.env` file in the project root with your credentials (see Environment Variables section below)

### Step 1: Install Dependencies (for package-lock.json)

```bash
npm install
```

### Step 2: Build Docker Image

```bash
docker build -t slack-rca-workflow:latest .
```

### Step 3: Start Server

```bash
# Using docker-compose (recommended)
docker-compose up -d

# OR using docker run
docker run -d \
  --name slack-rca-bot \
  -p 3000:8000 \
  --env-file .env \
  slack-rca-workflow:latest
```

### Step 4: Verify Server is Running

```bash
# Check health endpoint
curl http://localhost:8000/health

# Check container logs
docker logs slack-rca-bot

# Check container status
docker ps | grep slack-rca-bot
```

### Step 5: Configure Slack Webhook

1. Go to https://api.slack.com/apps
2. Select your app → **Event Subscriptions**
3. Set Request URL to: `https://your-domain.com/webhook/slack`
   - For local testing: Use ngrok: `ngrok http 8000` then use the ngrok HTTPS URL
4. Subscribe to `app_mentions` event
5. Save changes

### Step 6: Test

In Slack, mention your bot:
```
@bot The login button is not working
```

The bot will use the default repository from `BACKEND_REPO_URL` (or `GITHUB_REPO`) in your `.env` file.

### Stop Server

```bash
# Using docker-compose
docker-compose down

# OR using docker run
docker stop slack-rca-bot
docker rm slack-rca-bot
```

### View Logs

```bash
# View recent logs (last 100 lines)
docker logs slack-rca-bot --tail 100

# Follow logs in real-time (live streaming)
docker logs -f slack-rca-bot

# View logs with timestamps
docker logs -f --timestamps slack-rca-bot

# View logs from a specific time
docker logs --since 10m slack-rca-bot  # Last 10 minutes
docker logs --since 2024-01-01T00:00:00 slack-rca-bot  # From specific time
```

---

## Features

- ✅ Receives Slack `app_mention` events
- ✅ Extracts issue descriptions from user messages
- ✅ Extracts GitHub repository URLs from messages
- ✅ Analyzes GitHub repository code
- ✅ Creates Jira tickets with the reported issue
- ✅ Performs RCA analysis using OpenAI GPT-4 (focused on the specific issue)
- ✅ Posts RCA results as comments on Jira tickets
- ✅ Dockerized for easy deployment
- ✅ Slack signature verification for security

## Architecture

```
Slack Message (@bot The login button is not working. Analyze https://github.com/owner/repo)
    ↓
Slack Events API → /webhook/slack
    ↓
Extract Issue Description + GitHub Repo URL
    ↓
Analyze GitHub Repository (read code files)
    ↓
Create Jira Ticket (with issue description)
    ↓
Perform RCA Analysis (OpenAI - focused on the issue)
    ↓
Post RCA Results as Jira Comment
```

## Prerequisites

1. **Slack Workspace** with app creation permissions
2. **Jira Cloud** instance with API access
3. **OpenAI API Key** (for RCA analysis)
4. **GitHub Token** (optional, for private repos)
5. **Docker** (for containerization)

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `SLACK_BOT_TOKEN` - Slack bot OAuth token
- `SLACK_SIGNING_SECRET` - Slack app signing secret
- `JIRA_BASE_URL` - Your Jira instance URL
- `JIRA_EMAIL` - Jira account email
- `JIRA_API_TOKEN` - Jira API token
- `JIRA_PROJECT_KEY` - Jira project key
- `OPENAI_API_KEY` - OpenAI API key

Optional variables:
- `GIT_CLONE_TOKEN` - For private repositories
- `OPENAI_MODEL` - OpenAI model (default: gpt-4-turbo-preview)
- `PORT` - Server port (default: 3000)

### 2. Slack Bot Setup

1. Go to https://api.slack.com/apps
2. Create a new app or select existing app
3. **OAuth & Permissions**:
   - Add Bot Token Scopes:
     - `app_mentions:read`
     - `chat:write`
     - `channels:history`
   - Install to workspace
   - Copy Bot User OAuth Token → `SLACK_BOT_TOKEN`
4. **Event Subscriptions**:
   - Enable Events
   - Set Request URL: `https://your-domain.com/webhook/slack`
   - Subscribe to bot events: `app_mentions`
5. **Basic Information**:
   - Copy Signing Secret → `SLACK_SIGNING_SECRET`

### 3. Jira Setup

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Create API token
3. Copy token → `JIRA_API_TOKEN`
4. Note your Jira project key → `JIRA_PROJECT_KEY`

### 4. Build Docker Image

```bash
docker build -t slack-rca-workflow:latest .
```

### 5. Run Docker Container

```bash
docker run -d \
  --name slack-rca-bot \
  -p 8000:8000 \
  --env-file .env \
  slack-rca-workflow:latest
```

Or using docker-compose:

```bash
docker-compose up -d
```

**Note:** The server runs on port 8000 inside the container (or the port specified in `PORT` env variable). The docker-compose.yml maps host port 8000 to container port 8000.

## Usage

### In Slack

1. Invite the bot to a channel: `/invite @YourBotName`
2. Mention the bot with an issue description and GitHub repo:
   ```
   @bot The login button is not working. Analyze https://github.com/owner/repo
   ```
3. The bot will:
   - Read and understand the issue
   - Analyze the repository
   - Create a Jira ticket with the issue description
   - Perform RCA analysis focused on the issue
   - Post RCA results to Jira

### Example Flow

```
User: @bot The login button is not working. Analyze https://github.com/example/buggy-app

Bot: 📋 Issue: The login button is not working
     🔍 Analyzing repository: https://github.com/example/buggy-app
     📝 Creating Jira ticket...
     
Bot: ✅ Jira ticket created: PROJ-123
     🔬 Running RCA analysis on the issue...
     
Bot: ✅ RCA analysis completed and posted to PROJ-123
```

### Message Format

The bot expects:
- **Issue description**: What problem you're reporting
- **GitHub repository URL**: The repo to analyze

Examples:
- `@bot The API returns 500 errors. Analyze https://github.com/owner/repo`
- `@bot Users can't reset passwords. Check https://github.com/owner/repo`
- `@bot Performance issue in dashboard. Review https://github.com/owner/repo`

## Local Development

### Without Docker

```bash
# Install dependencies
npm install

# Run server
npm start

# Or with auto-reload
npm run dev
```

### With Docker (Development)

```bash
# Build
docker build -t slack-rca-workflow:dev .

# Run
docker run -it --rm \
  -p 8000:8000 \
  --env-file .env \
  slack-rca-workflow:dev
```

### Testing with ngrok

For local testing, expose your server with ngrok:

```bash
# Terminal 1: Start server
npm start

# Terminal 2: Start ngrok
ngrok http 8000

# Update Slack Event Subscriptions URL to ngrok URL
```

## API Endpoints

### `POST /webhook/slack`

Slack webhook endpoint for receiving events.

**Handles:**
- URL verification challenges
- `app_mention` events
- Signature verification

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Project Structure

```
slack-rca-workflow/
├── src/
│   ├── server.js          # Express server
│   ├── webhook.js         # Slack webhook handler
│   ├── job-processor.js    # Main workflow orchestrator
│   ├── jira-service.js    # Jira API integration
│   ├── github-service.js  # GitHub API integration
│   └── rca-service.js     # OpenAI RCA analysis
├── Dockerfile
├── package.json
├── .env.example
└── README.md
```

## Environment Variables Reference

**Note:** Docker Compose automatically loads variables from `.env` file. Just create a `.env` file in the project root with your credentials.

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | `8000` |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token | Yes | - |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Yes | - |
| `JIRA_BASE_URL` | Jira instance URL | Yes | - |
| `JIRA_USER` | Jira account email/username | Yes | - |
| `JIRA_API_TOKEN` | Jira API token | Yes | - |
| `JIRA_PROJECT_KEY` | Jira project key | Yes | - |
| `JIRA_ISSUE_TYPE` | Jira issue type | No | `Bug` |
| `GIT_CLONE_TOKEN` | GitHub token (for private repos) | No | - |
| `GIT_CLONE_TOKEN` | Alternative GitHub token | No | - |
| `BACKEND_REPO_URL` | Default GitHub repo (if not in message) | No | - |
| `BACKEND_BRANCH` | Default branch for repo analysis | No | `main` |
| `OPENAI_API_KEY` | OpenAI API key | Yes | - |
| `OPENAI_MODEL` | OpenAI model | No | `gpt-4-turbo-preview` |

## Troubleshooting

### Slack webhook not receiving events

- Verify bot is invited to channel
- Check Event Subscriptions shows "Verified ✓"
- Ensure `app_mentions` event is subscribed
- Check server logs for errors

### GitHub repository access issues

- For private repos, set `GIT_CLONE_TOKEN`
- Verify repository URL format is correct
- Check GitHub API rate limits

### Jira ticket creation fails

- Verify Jira credentials
- Check `JIRA_PROJECT_KEY` is correct
- Ensure user has "Create Issues" permission
- Check API logs for specific errors

### RCA analysis fails

- Verify `OPENAI_API_KEY` is set
- Check OpenAI API quota/limits
- Review code context size (may be too large)
- Check logs for OpenAI API errors

### Docker container issues

- Verify `.env` file exists and is correct
- Check container logs: `docker logs slack-rca-bot`
- Ensure port 8000 is not in use
- Verify Docker is running

## Security Notes

- ✅ Slack signature verification implemented
- ⚠️ Never commit `.env` file to git
- ⚠️ Use secrets management in production (AWS Secrets Manager, etc.)
- ⚠️ Rate limiting recommended for production
- ⚠️ Consider adding authentication for health endpoint

## Limitations

- Analyzes first 50 code files (to avoid rate limits)
- Code context limited to ~100k characters
- Files truncated to 2000 characters each
- OpenAI API rate limits apply
- GitHub API rate limits apply (60 req/hour without token)

## Future Enhancements

- [ ] Support for multiple GitHub repos in one message
- [ ] Thread-based conversation tracking
- [ ] File attachment support
- [ ] Custom RCA prompts per project
- [ ] Caching of repository analysis
- [ ] Webhook retry logic
- [ ] Metrics and monitoring
- [ ] Support for GitLab/Bitbucket

## License

MIT

