
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

ENV PORT=8080 DATABASE_PATH=/data/app.sqlite3
# 构建期用临时库校验迁移可执行；运行时 openDatabase 会自动对挂载卷应用迁移
RUN DATABASE_PATH=/tmp/build-check.sqlite3 npm run migrate
EXPOSE 8080
CMD ["npm", "start"]
