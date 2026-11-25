module.exports = {
  apps: [
    {
      name: "delvekbot",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: 3000,
      },
    },
  ],
};
