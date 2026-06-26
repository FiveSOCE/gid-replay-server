require("dotenv").config();

const express = require("express");
const multer = require("multer");
const { parseEvent } = require("@laihoe/demoparser2");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const bz2 = require("unbzip2-stream");

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");

const app = express();

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const steamClient = new SteamUser();
const csgo = new GlobalOffensive(steamClient);

let pendingSteamGuardCallback = null;

let steamStatus = {
  loggedIn: false,
  steamGuardRequired: false,
  cs2Ready: false,
  lastError: null
};

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim()
  }
});

const upload = multer({
  dest: "uploads/"
});

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function downloadR2FileToDisk(r2Key, localPath) {
  const result = await r2.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME.trim(),
    Key: r2Key
  }));

  const writeStream = fs.createWriteStream(localPath);

  await new Promise((resolve, reject) => {
    result.Body.pipe(writeStream);
    result.Body.on("error", reject);
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
}

async function downloadValveDemoToDisk(demoUrl, localDemPath) {
  const response = await axios({
    method: "GET",
    url: demoUrl,
    responseType: "stream"
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(localDemPath);

    response.data
      .pipe(bz2())
      .pipe(writer);

    response.data.on("error", reject);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function requestMatchByShareCode(shareCode) {
  return new Promise((resolve, reject) => {
    if (!steamStatus.cs2Ready) {
      return reject(new Error("CS2 Game Coordinator is not ready"));
    }

    const timeout = setTimeout(() => {
      csgo.removeListener("matchList", onMatchList);
      reject(new Error("Timed out waiting for matchList response"));
    }, 30000);

    function onMatchList(matches, data) {
      clearTimeout(timeout);
      resolve({ matches, raw: data });
    }

    csgo.once("matchList", onMatchList);
    csgo.requestGame(shareCode);
  });
}

function findDemoUrlFromMatchResult(result) {
  const matches = result.matches || [];

  for (const match of matches) {
    const rounds = match.roundstatsall || [];

    for (const round of rounds) {
      if (round.map && typeof round.map === "string" && round.map.startsWith("http")) {
        return round.map;
      }
    }
  }

  return null;
}

function parseDemoStats(localPath, r2DemoKey, r2ResultKey) {
  const kills = parseEvent(
    localPath,
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

  return {
    success: true,
    parsed: true,
    r2DemoKey,
    r2ResultKey,
    totalKillEvents: kills.length,
    realKillEvents: realKills.length,
    players: playerStats
  };
}

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

app.post("/create-upload-url", express.json(), async (req, res) => {
  try {
    const fileName = req.body.fileName || `demo-${Date.now()}.dem`;
    const r2Key = `raw-demos/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: r2Key,
      ContentType: "application/octet-stream"
    });

    const uploadUrl = await getSignedUrl(r2, command, {
      expiresIn: 60 * 10
    });

    res.json({
      success: true,
      r2Key,
      uploadUrl,
      expiresInSeconds: 600
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not create upload URL",
      error: error.message
    });
  }
});

app.post("/test-upload", upload.single("demo"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const r2Key = `test-uploads/${Date.now()}-${req.file.originalname}`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: r2Key,
      Body: fs.createReadStream(filePath),
      ContentType: req.file.mimetype || "application/octet-stream"
    }));

    res.json({
      success: true,
      message: "File uploaded to R2 successfully",
      originalName: req.file.originalname,
      size: req.file.size,
      r2Uploaded: true,
      r2Key
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Test upload failed",
      error: error.message
    });
  }
});

app.post("/upload-demo", upload.single("demo"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const r2Key = `raw-demos/${Date.now()}-${req.file.originalname}`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: r2Key,
      Body: fs.createReadStream(filePath),
      ContentType: "application/octet-stream"
    }));

    res.json({
      success: true,
      message: "Demo uploaded to R2 successfully. Parsing not started yet.",
      originalName: req.file.originalname,
      size: req.file.size,
      r2Uploaded: true,
      r2DemoKey: r2Key
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Demo upload failed",
      error: error.message
    });
  }
});

app.post("/parse-demo", express.json(), async (req, res) => {
  try {
    const r2Key = req.body.r2Key;

    if (!r2Key) {
      return res.status(400).json({
        success: false,
        message: "Missing r2Key"
      });
    }

    const localPath = `uploads/${Date.now()}-parse.dem`;
    await downloadR2FileToDisk(r2Key, localPath);

    const resultKey = `parsed-results/${Date.now()}-${r2Key.split("/").pop()}.json`;
    const resultData = parseDemoStats(localPath, r2Key, resultKey);

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: resultKey,
      Body: JSON.stringify(resultData, null, 2),
      ContentType: "application/json"
    }));

    fs.unlinkSync(localPath);

    res.json(resultData);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Parse failed",
      error: error.message
    });
  }
});

app.get("/results", async (req, res) => {
  try {
    const key = req.query.key;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Missing ?key=parsed-results/filename.json"
      });
    }

    const result = await r2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: key
    }));

    const text = await streamToString(result.Body);

    res.json(JSON.parse(text));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not fetch result",
      error: error.message
    });
  }
});

app.post("/test-cs2-history", express.json(), async (req, res) => {
  try {
    const { shareCode } = req.body;

    if (!shareCode) {
      return res.status(400).json({
        success: false,
        message: "Missing shareCode"
      });
    }

    const result = await requestMatchByShareCode(shareCode);
    const demoUrl = findDemoUrlFromMatchResult(result);

    res.json({
      success: true,
      message: "Match history response received",
      demoUrl,
      result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not fetch match from share code",
      error: error.message
    });
  }
});

app.post("/ingest-share-code", express.json(), async (req, res) => {
  try {
    const { shareCode } = req.body;

    if (!shareCode) {
      return res.status(400).json({
        success: false,
        message: "Missing shareCode"
      });
    }

    const matchResult = await requestMatchByShareCode(shareCode);
    const demoUrl = findDemoUrlFromMatchResult(matchResult);

    if (!demoUrl) {
      return res.status(404).json({
        success: false,
        message: "No demo URL found in match result"
      });
    }

    const safeName = shareCode.replace(/[^a-zA-Z0-9-]/g, "");
    const localDemPath = path.join("uploads", `${Date.now()}-${safeName}.dem`);

    await downloadValveDemoToDisk(demoUrl, localDemPath);

    const r2Key = `raw-demos/${Date.now()}-${safeName}.dem`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME.trim(),
      Key: r2Key,
      Body: fs.createReadStream(localDemPath),
      ContentType: "application/octet-stream"
    }));

    fs.unlinkSync(localDemPath);

    res.json({
      success: true,
      message: "Demo downloaded from Valve and uploaded to R2",
      shareCode,
      demoUrl,
      r2DemoKey: r2Key
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not ingest share code",
      error: error.message
    });
  }
});

app.post("/steam-login/start", async (req, res) => {
  try {
    steamStatus = {
      loggedIn: false,
      steamGuardRequired: false,
      cs2Ready: false,
      lastError: null
    };

    steamClient.logOn({
      accountName: process.env.STEAM_USERNAME,
      password: process.env.STEAM_PASSWORD
    });

    res.json({
      success: true,
      message: "Steam login started. Check Railway logs or /steam-status."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/steam-login/code", express.json(), async (req, res) => {
  const code = req.body.code;

  if (!code) {
    return res.status(400).json({
      success: false,
      message: "Missing code"
    });
  }

  if (!pendingSteamGuardCallback) {
    return res.status(400).json({
      success: false,
      message: "No Steam Guard code is currently pending"
    });
  }

  pendingSteamGuardCallback(code);
  pendingSteamGuardCallback = null;
  steamStatus.steamGuardRequired = false;

  res.json({
    success: true,
    message: "Steam Guard code submitted"
  });
});

app.get("/steam-status", (req, res) => {
  res.json(steamStatus);
});

steamClient.on("steamGuard", (domain, callback) => {
  console.log("Steam Guard required. Email domain:", domain);

  steamStatus.steamGuardRequired = true;
  pendingSteamGuardCallback = callback;
});

steamClient.on("loggedOn", () => {
  console.log("Steam logged in successfully");

  steamStatus.loggedIn = true;
  steamStatus.steamGuardRequired = false;
  steamStatus.lastError = null;

  steamClient.setPersona(SteamUser.EPersonaState.Online);
  steamClient.gamesPlayed([730]);

  console.log("Requested CS2 Game Coordinator connection");
});

steamClient.on("error", (error) => {
  console.error("Steam error:", error);

  steamStatus.lastError = error.message;
});

csgo.on("connectedToGC", () => {
  console.log("Connected to CS2 Game Coordinator");
  steamStatus.cs2Ready = true;
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});