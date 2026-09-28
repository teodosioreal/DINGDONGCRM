// pm2 start deploy/ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'dingdong-crm',
      script: 'server.js',
      cwd: __dirname + '/..',
      exec_mode: 'fork',
      instances: 1, // o banco é um arquivo JSON: rode só UMA instância
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 5000
    }
  ]
};
