// PM2 process configuration template.
// Copy this file to `ecosystem.config.js` and adjust values for your deployment.
// The real ecosystem.config.js is git-ignored; keep secrets/ids in your local .env instead.
module.exports = {
  apps: [
    {
      name: 'assistant-bot',
      script: 'bot.js',
      cwd: '/path/to/app',
      node_args: '--env-file=.env', // loads LLM keys, group ids, etc. from .env
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: '600M',
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      time: true,
    },
    {
      name: 'assistant-curator',
      script: 'curator.js',
      cwd: '/path/to/app',
      node_args: '--env-file=.env',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '400M',
      env: {
        CURATOR_INTERVAL_MS: '300000', // 5 min
      },
      out_file: 'logs/curator-out.log',
      error_file: 'logs/curator-error.log',
      time: true,
    },
  ],
}
