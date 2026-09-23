
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

ENV PORT=8080 DATABASE_PATH=/data/app.sqlite3
# 启动时自动幂等执行 migrations/ 下全部迁移（数据卷在运行时挂载，构建期不建库）。
EXPOSE 8080
CMD ["npm", "start"]
