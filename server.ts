import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // In-memory state (for demo purposes, normally you'd use a database)
  let users: any[] = [];
  let attendance: any[] = [];

  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Send initial state
    socket.emit("initial_state", { users, attendance });

    socket.on("register_user", (user) => {
      users.push(user);
      io.emit("user_registered", user);
    });

    socket.on("add_attendance", (record) => {
      attendance.unshift(record);
      io.emit("attendance_added", record);
    });

    socket.on("mark_absents", (records) => {
      attendance = [...records, ...attendance];
      io.emit("absents_marked", records);
    });

    socket.on("mark_absent", (record) => {
      attendance.unshift(record);
      io.emit("attendance_added", record);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
