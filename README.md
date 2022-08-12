# 

# Slack Setup

1. Create a new App.
2. Go To OAuth and Permissions under the Features section.
3. Under Scopes and Bot Token Scopes, grant the following scopes:

- `channels:history`
- `chat:write`
- `chat:write.public`

4. Then above that in the OAuth Tokens for Your Workspace section, install it
   into the workspace.
5. Take note of the token.
6. Open up your slack workspace and find the channel you wish to publish events
   to. Right click and select "View Channel Details". At the bottom, there is
   a Channel ID. Copy that ID.

# Github Setup

From a user account that has access to the repos you wish to, create a new
API token with the `repo` scope. Take note of that token.
