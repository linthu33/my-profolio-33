# Node.js version 18 (Alpine is lightweight)
FROM node:22-alpine

# Working directory သတ်မှတ်ခြင်း
WORKDIR /usr/src/app

# Package.json နှင့် Package-lock.json များကို ကူးယူခြင်း
COPY package*.json ./

# Dependencies များ install လုပ်ခြင်း
RUN npm install --production

# Project file အားလုံးကို ကူးယူခြင်း
COPY . .

# Port သတ်မှတ်ခြင်း
EXPOSE 3200

# Server စတင်ရန် Command
CMD [ "node", "server.js" ]