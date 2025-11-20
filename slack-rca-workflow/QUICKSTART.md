# Quick Start Guide

Get your Slack-RCA workflow bot running in 5 minutes!

## Prerequisites

- Docker installed
- Slack workspace admin access
- Jira account with API access
- OpenAI API key

## Step 1: Clone and Setup

```bash
cd slack-rca-workflow
cp .env.example .env
```

## Step 2: Configure Environment

Edit `.env` and add your credentials:

```bash
# Required
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-token
JIRA_PROJECT_KEY=PROJ
OPENAI_API_KEY=sk-your-key
```

## Step 3: Build and Run

```bash
# Build Docker image
docker build -t slack-rca-workflow:latest .

# Run container
docker run -d \
  --name slack-rca-bot \
  -p 3000:3000 \
  --env-file .env \
  slack-rca-workflow:latest

# Or use docker-compose
docker-compose up -d
```

## Step 4: Configure Slack

1. Go to https://api.slack.com/apps
2. Select your app → Event Subscriptions
3. Set Request URL: `https://your-domain.com/webhook/slack`
   - For local testing: Use ngrok: `ngrok http 3000`
4. Subscribe to `app_mentions` event
5. Save changes

## Step 5: Test

In Slack, mention your bot with an issue and GitHub repo:

```
@your-bot The login button is not working. Analyze https://github.com/owner/repo
```

The bot will:
1. ✅ Read the issue description
2. ✅ Analyze the GitHub repository
3. ✅ Create a Jira ticket with the issue
4. ✅ Run RCA analysis focused on the issue
5. ✅ Post results to Jira

## Troubleshooting

### Check logs
```bash
docker logs slack-rca-bot
```

### Restart container
```bash
docker restart slack-rca-bot
```

### Test health endpoint
```bash
curl http://localhost:3000/health
```

## Next Steps

- See [README.md](README.md) for detailed documentation
- Configure GitHub token for private repos
- Set up production deployment
- Add monitoring and alerts

