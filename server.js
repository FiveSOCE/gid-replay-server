const express = require("express");
const multer = require("multer");

const app = express();
const upload = multer({
  dest: "uploads/"
});

app.get("/", (req, res) => {
  res.json({
    status: "alive",
    message: "GID Replay Parser Online ya bihh"
  });
});

app.get("/upload-demo", (req, res) => {
  res.json({
    status: "success",
    message: "Upload endpoint exists"
  });
});

app.post("/upload-demo", upload.single("demo"), (req, res) => {

  res.json({
    success: true,
    originalName: req.file.originalname,
    savedAs: req.file.filename,
    size: req.file.size
  });

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});