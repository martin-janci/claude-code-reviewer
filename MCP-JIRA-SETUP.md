# Jira MCP Server Setup

## What Was Configured

Added Jira MCP server integration to this project for programmatic access to Jira tickets.

### Files Created/Modified

1. **`.mcp.json`** (NEW) - MCP server configuration
   - Configured `mcp-jira-stdio` server
   - Connected to PapayaPOS Jira: https://papayapos.atlassian.net
   - Credentials for martin.janci@papayapos.sk

2. **`.claude/settings.json`** (MODIFIED)
   - Added `"enableAllProjectMcpServers": true`
   - This automatically enables all MCP servers defined in `.mcp.json`

3. **`.gitignore`** (MODIFIED)
   - Added `.mcp.json` to prevent committing sensitive credentials

## How to Activate

**IMPORTANT:** You must restart Claude Code for the MCP server to load.

1. Exit Claude Code completely (Cmd+Q or similar)
2. Restart Claude Code
3. Open this project again
4. The Jira MCP tools will now be available

## Available Jira Operations

Once activated, you can:

- **View issues**: Get full details of any Jira ticket
- **Update issues**: Modify descriptions, summaries, assignees, etc.
- **Search issues**: Use JQL queries to find tickets
- **Add comments**: Post comments to tickets
- **Create issues**: Create new bugs, tasks, stories
- **Transition issues**: Move tickets through workflow states
- **Manage sprints**: View and modify sprint assignments

## Example Usage

After restart, you can say:

```
View Jira ticket PD-1926
```

```
Update PD-1926 description with the Kubernetes setup documentation
```

```
Search for all open PD tickets assigned to me
```

```
Add a comment to PD-1926 about the deployment
```

## Security Note

- `.mcp.json` contains your Jira API token
- This file is in `.gitignore` and will NOT be committed to git
- Never share this file or commit it to version control
- Rotate the API token if it's ever exposed

## Verification

After restart, check that the MCP server loaded:

1. In Claude Code, type: `/mcp-tools` (if such command exists)
2. Or simply try: "View Jira ticket PD-1926"
3. You should see Jira operations working

## What's Next

Once the MCP server is active, I can:
1. View PD-1926 ticket details
2. Update the description with comprehensive Kubernetes setup docs
3. Publish the changes to Jira
4. Explain the Kubernetes deployment architecture

## Files to Update PD-1926

The Kubernetes documentation is ready in:
- `JIRA-PD-1926-kubernetes-setup.md` - Complete Kubernetes deployment guide
- `k8s/README.md` - Kubernetes-specific deployment instructions
- `SETUP.md` - General setup guide including Kubernetes section

After restart, I'll update PD-1926 with this content.
