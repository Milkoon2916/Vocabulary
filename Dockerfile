# ---- 1) 프론트엔드(Vite) 빌드 ----
FROM node:20-alpine AS client-build
WORKDIR /app/client

# 선생님 모드 비밀번호를 빌드 시점에 프론트엔드에 심어줌
# (서버의 TEACHER_PIN 환경변수와 반드시 같은 값이어야 해요)
ARG VITE_TEACHER_PIN=5136
ENV VITE_TEACHER_PIN=${VITE_TEACHER_PIN}

COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- 2) 서버 실행 이미지 ----
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY --from=client-build /app/client/dist ./client/dist

# Render가 PORT 환경변수를 자동으로 주입해요 (기본값은 10000)
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
