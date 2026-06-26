const express = require("express");
const multer = require("multer");
const { parseEvent } = require("@laihoe/demoparser2");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const upload = multer({
  dest: "uploads/"
});

app.get("/", (req, res) => {
  res.json({
    status: "alive",
    message: "GID Replay Parser Online"
  });
});

app.get("/upload-demo", (req, res) => {
  res.json({
    status: "success",
    message: "Upload endpoint exists. Use POST to upload a demo."
  });
});

app.post("/upload-demo", upload.single("demo"), async (req, res) => {
  try {
    const filePath = req.file.path;

const r2Key = `raw-demos/${Date.now()}-${req.file.originalname}`;

await r2.send(new PutObjectCommand({
  Bucket: process.env.R2_BUCKET_NAME,
  Key: r2Key,
  Body: fs.createReadStream(filePath),
  ContentType: "application/octet-stream"
}));

    const kills = parseEvent(
      filePath,
      "player_death",
      ["attacker_name", "user_name", "weapon", "headshot"],
      ["total_rounds_played"]
    );

const realKills = kills.filter(kill => kill.total_rounds_played > 0);

const players = {};

for (const kill of realKills) {
  const attackerId = kill.attacker_steamid;
  const victimId = kill.user_steamid;

  if (attackerId) {
    if (!players[attackerId]) {
      players[attackerId] = {
        steamid: attackerId,
        name: kill.attacker_name,
        kills: 0,
        deaths: 0,
        headshots: 0
      };
    }

    players[attackerId].kills += 1;

    if (kill.headshot) {
      players[attackerId].headshots += 1;
    }
  }

  if (victimId) {
    if (!players[victimId]) {
      players[victimId] = {
        steamid: victimId,
        name: kill.user_name,
        kills: 0,
        deaths: 0,
        headshots: 0
      };
    }

    players[victimId].deaths += 1;
  }
}

const playerStats = Object.values(players)
  .map(player => ({
    ...player,
    kd:
      player.deaths > 0
        ? Math.round((player.kills / player.deaths) * 100) / 100
        : player.kills,
    killDeathDiff: player.kills - player.deaths,
    headshotPercent:
      player.kills > 0
        ? Math.round((player.headshots / player.kills) * 1000) / 10
        : 0
  }))
  .sort((a, b) => b.kills - a.kills);

res.json({
  success: true,
  originalName: req.file.originalname,
  size: req.file.size,
  parsed: true,
r2Uploaded: true,
r2Key: r2Key,
  totalKillEvents: kills.length,
  realKillEvents: realKills.length,
  players: playerStats
});
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Demo uploaded, but parsing failed",
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});