"use strict";
import { Socket, Server } from "net";
import express from "express";
import bodyParser from 'body-parser';

const http_port: string | number = process.env.HTTP_PORT || 3001;
const p2p_port: number = parseInt(process.env.P2P_PORT ?? "0", 10) || 6001;
const initialPeers: string[] = process.env.PEERS
  ? process.env.PEERS.split(",")
  : [];

class Block {
  index: number;
  previousHash: string;
  timestamp: number;
  data: any;
  hash: string;
  constructor(
    index: number,
    previousHash: string,
    timestamp: number,
    data: any,
    hash: string
  ) {
    this.index = index;
    this.previousHash = previousHash.toString();
    this.timestamp = timestamp;
    this.data = data;
    this.hash = hash.toString();
  }
}

const sockets: Socket[] = [];
const MessageType = {
  QUERY_LATEST: 0,
  QUERY_ALL: 1,
  RESPONSE_BLOCKCHAIN: 2,
};

const getGenesisBlock = (): Block => {
  return new Block(
    0,
    "0",
    1465154705,
    "my genesis block!!",
    "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7"
  );
};

let blockchain: Block[] = [getGenesisBlock()];

const initHttpServer = () => {
  const app: express.Application = express();
  app.use(bodyParser.json());

  app.get("/blocks", (_req, res) => {
    res.send(JSON.stringify(blockchain));
  });
  app.post("/mineBlock", (req, res) => {
    var newBlock = generateNextBlock(req.body.data);
    addBlock(newBlock);
    broadcast(responseLatestMsg());
    console.log("block added: " + JSON.stringify(newBlock));
    res.send();
  });
  app.get("/peers", (req, res) => {
    res.send(sockets.map((s) => s.remoteAddress + ":" + s.remotePort));
  });
  app.post("/addPeer", (req, res) => {
    connectToPeers([req.body.peer]);
    res.send();
  });
  app.listen(http_port, () =>
    console.log("Listening http on port: " + http_port)
  );
};

var initP2PServer = () => {
  const server = new Server();
  server.on("connection", (ws: Socket) => initConnection(ws));
  console.log("listening websocket p2p port on: " + p2p_port);
};

var initConnection = (ws: Socket) => {
  sockets.push(ws);
  initMessageHandler(ws);
  initErrorHandler(ws);
  write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws: Socket) => {
  ws.on("message", (data) => {
    var message = JSON.parse(data.toString());
    console.log("Received message" + JSON.stringify(message));
    switch (message.type) {
      case MessageType.QUERY_LATEST:
        write(ws, responseLatestMsg());
        break;
      case MessageType.QUERY_ALL:
        write(ws, responseChainMsg());
        break;
      case MessageType.RESPONSE_BLOCKCHAIN:
        handleBlockchainResponse(message);
        break;
    }
  });
};

const initErrorHandler = (ws: Socket) => {
  const closeConnection = (ws: Socket) => {
    console.log(
      "connection failed to peer: " + ws.remoteAddress + ":" + ws.remotePort
    );
    sockets.splice(sockets.indexOf(ws), 1);
  };
  ws.on("close", () => closeConnection(ws));
  ws.on("error", () => closeConnection(ws));
};

const generateNextBlock = (blockData: Block) => {
  const previousBlock: Block = getLatestBlock();
  const nextIndex: number = previousBlock.index + 1;
  const nextTimestamp: number = new Date().getTime() / 1000;
  const nextHash: string = calculateHash(
    nextIndex,
    previousBlock.hash,
    nextTimestamp,
    blockData
  );
  return new Block(
    nextIndex,
    previousBlock.hash,
    nextTimestamp,
    blockData,
    nextHash
  );
};

const calculateHashForBlock = (block: Block) => {
  return calculateHash(
    block.index,
    block.previousHash,
    block.timestamp,
    block.data
  );
};

const calculateHash = (
  index: number,
  previousHash: string,
  timestamp: number,
  data: any
) => {
  return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

const addBlock = (newBlock: Block) => {
  if (isValidNewBlock(newBlock, getLatestBlock())) {
    blockchain.push(newBlock);
  }
};

const isValidNewBlock = (newBlock: Block, previousBlock: Block) => {
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log("invalid index");
    return false;
  } else if (previousBlock.hash !== newBlock.previousHash) {
    console.log("invalid previoushash");
    return false;
  } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
    console.log(
      typeof newBlock.hash + " " + typeof calculateHashForBlock(newBlock)
    );
    console.log(
      "invalid hash: " + calculateHashForBlock(newBlock) + " " + newBlock.hash
    );
    return false;
  }
  return true;
};

const connectToPeers = (newPeers: string[]) => {
  newPeers.forEach((peer) => {
    const ws = new Socket({});
    ws.connect(p2p_port, peer);
    ws.on("open", () => initConnection(ws));
    ws.on("error", () => {
      console.log("connection failed");
    });
  });
};

const handleBlockchainResponse = (message: { data: string }) => {
  const receivedBlocks = JSON.parse(message.data).sort(
    (b1: { index: number }, b2: { index: number }) => b1.index - b2.index
  );
  const latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
  const latestBlockHeld = getLatestBlock();
  if (latestBlockReceived.index > latestBlockHeld.index) {
    console.log(
      "blockchain possibly behind. We got: " +
        latestBlockHeld.index +
        " Peer got: " +
        latestBlockReceived.index
    );
    if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
      console.log("We can append the received block to our chain");
      blockchain.push(latestBlockReceived);
      broadcast(responseLatestMsg());
    } else if (receivedBlocks.length === 1) {
      console.log("We have to query the chain from our peer");
      broadcast(queryAllMsg());
    } else {
      console.log("Received blockchain is longer than current blockchain");
      replaceChain(receivedBlocks);
    }
  } else {
    console.log(
      "received blockchain is not longer than current blockchain. Do nothing"
    );
  }
};

const replaceChain = (newBlocks: Block[]) => {
  if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
    console.log(
      "Received blockchain is valid. Replacing current blockchain with received blockchain"
    );
    blockchain = newBlocks;
    broadcast(responseLatestMsg());
  } else {
    console.log("Received blockchain invalid");
  }
};

const isValidChain = (blockchainToValidate: Block[]) => {
  if (
    JSON.stringify(blockchainToValidate[0]) !==
    JSON.stringify(getGenesisBlock())
  ) {
    return false;
  }
  var tempBlocks = [blockchainToValidate[0]];
  for (var i = 1; i < blockchainToValidate.length; i++) {
    if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
      tempBlocks.push(blockchainToValidate[i]);
    } else {
      return false;
    }
  }
  return true;
};

const getLatestBlock = () => blockchain[blockchain.length - 1];
const queryChainLengthMsg = () => ({ type: MessageType.QUERY_LATEST });
const queryAllMsg = () => ({ type: MessageType.QUERY_ALL });
const responseChainMsg = () => ({
  type: MessageType.RESPONSE_BLOCKCHAIN,
  data: JSON.stringify(blockchain),
});
const responseLatestMsg = () => ({
  type: MessageType.RESPONSE_BLOCKCHAIN,
  data: JSON.stringify([getLatestBlock()]),
});

const write = (ws: Socket, message: { type: number; data?: string }) =>
  ws.write(JSON.stringify(message));
const broadcast = (message: { type: number; data?: string | undefined }) =>
  sockets.forEach((socket) => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
