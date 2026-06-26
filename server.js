require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { parseEvent } = require("@laihoe/demoparser2");
const fs = require("fs");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim()
  }
});

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

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
      r2Key: r2Key
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
});  } catch (error) {
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