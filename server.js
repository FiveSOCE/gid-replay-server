const express = require("express");

const app = express();

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});