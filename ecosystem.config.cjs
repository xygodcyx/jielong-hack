module.exports = {
  apps: [
    {
      name: 'jielong-studio',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: 'node',
      node_args: ['--env-file-if-exists=.env', '--enable-source-maps'],
      // 调度与 SQLite 按单实例设计，不使用 cluster 或 pm2 scale。
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 65000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
