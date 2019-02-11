const { Server } = require('http');
const { Nuxt } = require('nuxt-start');
const { Bridge } = require('./now__bridge.js');

const bridge = new Bridge();
bridge.port = 3000;

process.env.NODE_ENV = 'production';

const config = require('./nuxt.config.js');
config.dev = false;
const nuxt = new Nuxt(config);

const server = new Server(nuxt.render)
server.listen(bridge.port);

exports.launcher = bridge.launcher;
