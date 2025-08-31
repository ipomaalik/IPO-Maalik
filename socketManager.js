// socketManager.js
let io;

module.exports = {
  init: (httpServer) => {
    io = require("socket.io")(httpServer);
    io.on("connection", (socket) => {
      console.log("A user connected via WebSocket");
      socket.on("disconnect", () => {
        console.log("User disconnected");
      });
    });
    return io;
  },
  getIO: () => {
    if (!io) {
      throw new Error("Socket.io not initialized!");
    }
    return io;
  },
};