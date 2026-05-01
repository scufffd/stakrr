module.exports = {
  apps: [
    {
      name: "stakrr-api",
      namespace: "stakrr",
      script: "src/server.js",
      cwd: "/home/stakrr/stakrr/worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "250M",
      env: { NODE_ENV: "production" },
      out_file: "/home/stakrr/.pm2/logs/stakrr-api-out.log",
      error_file: "/home/stakrr/.pm2/logs/stakrr-api-err.log",
      time: true,
    },
    {
      name: "stakrr-loop",
      namespace: "stakrr",
      script: "scripts/run-loop.js",
      cwd: "/home/stakrr/stakrr/worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "250M",
      env: { NODE_ENV: "production" },
      out_file: "/home/stakrr/.pm2/logs/stakrr-loop-out.log",
      error_file: "/home/stakrr/.pm2/logs/stakrr-loop-err.log",
      time: true,
    },
    {
      // Slow background vanity grinder. Tops up data/vanity-pump.json with
      // *pump suffixed mints. Tuned for the 1-vCPU Faith droplet:
      //   • 1 thread, batch 1, 90s sleep, nice 19 (lowest priority).
      //   • The Linux scheduler will pre-empt this whenever stakrr-api or
      //     stakrr-loop need CPU, so launches stay snappy.
      //   • Sleeps 10 min when pool ≥ GRIND_TARGET (essentially idle).
      // See scripts/grind-vanity.js + .env.example for the full env knob list.
      name: "stakrr-grind",
      namespace: "stakrr",
      script: "scripts/grind-vanity.js",
      args: "--daemon",
      cwd: "/home/stakrr/stakrr/worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "120M",
      env: { NODE_ENV: "production" },
      out_file: "/home/stakrr/.pm2/logs/stakrr-grind-out.log",
      error_file: "/home/stakrr/.pm2/logs/stakrr-grind-err.log",
      time: true,
      autorestart: true,
      restart_delay: 5000,
    },
  ],
};
