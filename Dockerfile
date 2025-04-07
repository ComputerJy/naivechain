FROM node:4.6

RUN mkdir /naivechain
ADD package.json /naivechain/
ADD main.ts /naivechain/

RUN cd /naivechain && npm install

EXPOSE 3001
EXPOSE 6001

ENTRYPOINT cd /naivechain && npm install && PEERS=$PEERS npm start