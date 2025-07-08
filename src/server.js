import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Resolvenddo caminho para .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const server = http.createServer(app); // Usando HTTP no Render

const PREFIX = "moot7_database_";
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";

// Rota base para health check do Render
app.get("/", (req, res) => {
  res.send("Socket.io server running on Render");
});

// Configuração Redis
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
  },
});
const redisSubcriber = redisClient.duplicate();

// Configuração do Socket.io
const io = new Server(server, {
  cors: {
    origin:
      NODE_ENV === "production"
        ? ["https://dev.moot7.com"]
        : [
            "https://dev.moot7.com",
            "http://dev.moot7.com",
            "http://localhost:3000",
            process.env.API_SOCKET_LOCAL_URL,
          ],
    methods: ["GET", "POST"],
    allowedHeaders: ["X-CSRF-TOKEN"],
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Conexão Redis e subscrição
(async () => {
  try {
    await redisClient.connect();
    await redisSubcriber.connect();
    await redisSubcriber.subscribe("presence_channel", (message) => {
      const { event, user } = JSON.parse(message);
      io.emit(event, user);
    });
    console.log("✅ Redis conectado e inscrito no canal de presença");
  } catch (error) {
    console.error("❌ Erro no Redis:", error);
  }
})();

const onlineUsers = {};

// Eventos do Socket.io
io.on("connection", (socket) => {
  socket.on("auth", async (user) => {
    console.log(user);
    try {
      const userId = socket.handshake.auth.userId;
      await redisClient.sAdd(`${PREFIX}online_users`, String(user.id));
      await redisClient.expire(`${PREFIX}online_users`, 100000);

      onlineUsers[userId] = user.id;
      socket.user = user;
      socket.emit("authenticated");
      socket.emit("is_online", user);
      console.log("Usuário autenticado:", user);
      socket.broadcast.emit("is_online", user);

      console.log(`👤 ${user.id} autenticado`);
    } catch (error) {
      console.error("Erro na autenticação:", error);
      socket.emit("auth_error", { message: "Falha na autenticação" });
    }
  });

  socket.on("join_room", (data) => {
    if (!data.chat_id) {
      console.error("Erro: chat_id não fornecido");
      socket.emit("error", { message: "chat_id não fornecido" });
      return;
    }

    const room = `chat.${data.chat_id}`;
    socket.join(room);
    console.log(`Cliente ${socket.id} entrou na sala ${room}`);
  });

  socket.on("send_message", (data) => {
    console.log("Mensagem recebida:", data);

    try {
      if (!data.message || !data.chat_id) {
        throw new Error("Dados incompletos para a mensagem");
      }

      const messageData = {
        ...data,
        timestamp: new Date().toISOString(),
      };

      io.to(`chat.${data.chat_id}`).emit("new_message", messageData);
    } catch (error) {
      console.error("Erro ao processar mensagem:", error.message);

      socket.emit("error", {
        message: "Erro ao enviar mensagem",
        details: error.message,
      });
    }
  });

  socket.on("logout_user", async (data) => {
    await redisClient.sRem(`${PREFIX}online_users`, String(data.user_id));
    console.log(`✅ Usuário ${data.user_id} deslogou`);
  });

  socket.on("disconnect", async () => {
    console.log("Cliente desconectado:", socket.id);

    if (socket.user?.id) {
      try {
        const wasOnline = await redisClient.sIsMember(
          `${PREFIX}online_users`,
          String(socket.user.id)
        );
        if (wasOnline) {
          await redisClient.sRem(
            `${PREFIX}online_users`,
            String(socket.user.id)
          );
          delete onlineUsers[socket.user.id];
          socket.broadcast.emit("is_offline", socket.user.id);
          console.log(`👋 ${socket.user.id} desconectado`);
        }
      } catch (error) {
        console.error("Erro ao remover usuário:", error);
      }
    }
    console.log(`🔌 ${socket.id} desconectado`);
  });

  socket.conn.on("packet", (packet) => {
    if (packet.type === "pong") {
      console.log("Pong recebido do client");
    }
  });
});

// Monitor de memória
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  console.log(`Uso de Memória: 
    RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB |
    Heap: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}/${(
    memoryUsage.heapTotal /
    1024 /
    1024
  ).toFixed(2)}MB`);
}, 60000);

// Tratamento de erros
process.on("uncaughtException", (err) => {
  console.error("Erro não tratado:", err);
});

process.on("warning", (warning) => {
  console.warn("Warning do Node.js:", warning);
});

// Inicia o servidor
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
  🚀 Servidor Socket.IO iniciado
  Modo: ${NODE_ENV}
  Porta: ${PORT}
  WebSocket: ws://localhost:${PORT}
  `);
});
