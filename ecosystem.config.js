// PM2 守护配置 —— 宿主直接跑 Node，无 Docker
// 启动：set -a && source .env && set +a && pm2 start ecosystem.config.js
// 部署：scripts/deploy.sh（git pull + pm2 reload）
module.exports = {
  apps: [
    {
      name: "ggcdc-oa",
      script: "server/server.js",
      cwd: "/home/ubuntu/cdc_oa",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        OA_DB_PATH: "/home/ubuntu/cdc_oa/data/oa.sqlite",
      },
      error_file: "/home/ubuntu/cdc_oa/logs/pm2-error.log",
      out_file: "/home/ubuntu/cdc_oa/logs/pm2-out.log",
      time: true,
      merge_logs: true,
    },
  ],
};
