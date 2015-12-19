var ws = require('ws');
var WSServer = ws.Server;
var SCSocket = require('./scsocket');
var AuthEngine = require('sc-auth').AuthEngine;
var EventEmitter = require('events').EventEmitter;
var base64id = require('base64id');
var async = require('async');
var url = require('url');
var domain = require('domain');
var crypto = require('crypto');
var uuid = require('node-uuid');
var scSimpleBroker = require('sc-simple-broker');

var scErrors = require('sc-errors');
var AuthTokenExpiredError = scErrors.AuthTokenExpiredError;
var SilentMiddlewareBlockedError = scErrors.SilentMiddlewareBlockedError;


var SCServer = function (options) {
  var self = this;

  var opts = {
    brokerEngine: scSimpleBroker,
    allowClientPublish: true,
    ackTimeout: 10000,
    pingTimeout: 20000,
    pingInterval: 8000,
    origins: '*:*',
    appName: uuid.v4(),
    path: '/socketcluster/',
    authDefaultExpiry: 86400,
    middlewareEmitWarnings: true
  };

  for (var i in options) {
    if (options.hasOwnProperty(i)) {
      opts[i] = options[i];
    }
  }

  this.MIDDLEWARE_HANDSHAKE = 'handshake';
  this.MIDDLEWARE_EMIT = 'emit';
  this.MIDDLEWARE_SUBSCRIBE = 'subscribe';
  this.MIDDLEWARE_PUBLISH_IN = 'publishIn';
  this.MIDDLEWARE_PUBLISH_OUT = 'publishOut';

  // Deprecated
  this.MIDDLEWARE_PUBLISH = this.MIDDLEWARE_PUBLISH_IN;

  this._subscribeEvent = '#subscribe';
  this._publishEvent = '#publish';

  // TODO: This needs to be a custom Error object with a name property
  this.ERROR_NO_PUBLISH = 'Error: Client publish feature is disabled';

  this._middleware = {};
  this._middleware[this.MIDDLEWARE_HANDSHAKE] = [];
  this._middleware[this.MIDDLEWARE_EMIT] = [];
  this._middleware[this.MIDDLEWARE_SUBSCRIBE] = [];
  this._middleware[this.MIDDLEWARE_PUBLISH_IN] = [];
  this._middleware[this.MIDDLEWARE_PUBLISH_OUT] = [];

  this.origins = opts.origins;
  this._allowAllOrigins = this.origins.indexOf('*:*') != -1;

  this.ackTimeout = opts.ackTimeout;
  this.pingInterval = opts.pingInterval;
  this.pingTimeout = opts.pingTimeout;
  this.allowClientPublish = opts.allowClientPublish;
  this.perMessageDeflate = opts.perMessageDeflate;
  this.httpServer = opts.httpServer;

  this._brokerEngine = opts.brokerEngine;
  this.appName = opts.appName || '';
  this.middlewareEmitWarnings = opts.middlewareEmitWarnings;
  this._path = opts.path;

  if (opts.authPrivateKey != null || opts.authPublicKey != null) {
    if (opts.authPrivateKey == null) {
      // TODO: This needs to be a custom Error object with a name property
      throw new Error('The authPrivateKey option must be specified if authPublicKey is specified');
    } else if (opts.authPublicKey == null) {
      // TODO: This needs to be a custom Error object with a name property
      throw new Error('The authPublicKey option must be specified if authPrivateKey is specified');
    }
    this.signatureKey = opts.authPrivateKey;
    this.verificationKey = opts.authPublicKey;
  } else {
    if (opts.authKey == null) {
      opts.authKey = crypto.randomBytes(32).toString('hex');
    }
    this.signatureKey = opts.authKey;
    this.verificationKey = opts.authKey;
  }

  this.defaultVerificationOptions = {};
  if (opts.authAlgorithm != null) {
    this.defaultVerificationOptions.algorithms = [opts.authAlgorithm];
  }

  this.defaultSignatureOptions = {
    algorithm: opts.authAlgorithm,
    expiresIn: opts.authDefaultExpiry
  };

  if (opts.authEngine) {
    this.auth = opts.authEngine;
  } else {
    // Default authentication engine
    this.auth = new AuthEngine();
  }

  this.clients = {};
  this.clientsCount = 0;

  this.exchange = this.global = this._brokerEngine.exchange();

  this.wsServer = new WSServer({
    server: this.httpServer,
    clientTracking: false,
    perMessageDeflate: this.perMessageDeflate,
    handleProtocols: opts.handleProtocols,
    verifyClient: this.verifyHandshake.bind(this)
  });

  this.wsServer.on('error', this._handleServerError.bind(this));
  this.wsServer.on('connection', this._handleSocketConnection.bind(this));
};

SCServer.prototype = Object.create(EventEmitter.prototype);

SCServer.prototype.setAuthEngine = function (authEngine) {
  this.auth = authEngine;
};

SCServer.prototype._handleServerError = function (error) {
  this.emit('error', error);
};

SCServer.prototype._handleSocketError = function (error) {
  // We don't want to crash the entire worker on socket error
  // so we emit it as a warning instead.
  var errorPrefix = 'Socket Error: ';
  if (error.message) {
    error.message = errorPrefix + error.message;
  } else if (typeof error == 'string') {
    error = errorPrefix + error;
  }
  this.emit('warning', error);
};

SCServer.prototype._handleHandshakeTimeout = function (scSocket) {
  // TODO: This needs to be a custom Error object with a name property
  // TODO: Is this a ServerProtocolError? Maybe it should be a SocketProtocolError with a status code?
  // Should we disconnect the socket?
  var errorMessage = new Error('Did not receive #handshake from client before timeout');
  scSocket.emit('error', errorMessage);
};

SCServer.prototype._processTokenError = function (socket, err, signedAuthToken) {
  // In case of an expired, malformed or invalid token, emit an event
  // and keep going without a token.
  var authError = null;

  if (err) {
    err.signedAuthToken = signedAuthToken;
    // TODO: Maybe this should be emitted as an 'error' event with a custom Error type instead?
    socket.emit('badAuthToken', err);
    this.emit('badSocketAuthToken', socket, err);

    // TODO: Maybe this should be a custom Error object with name property?
    authError = {
      name: err.name,
      message: err.message
    };
  }

  return authError;
};

SCServer.prototype._handleSocketConnection = function (wsSocket) {
  var self = this;

  var id = this.generateId();

  var socketDomain = domain.createDomain();
  var scSocket = new SCSocket(id, this, wsSocket);
  socketDomain.add(scSocket);

  // Emit event to signal that a socket handshake has been initiated.
  // The _handshake event is for internal use (including third-party plugins)
  this.emit('_handshake', scSocket);
  this.emit('handshake', scSocket);

  socketDomain.on('error', function (err) {
    self._handleSocketError(err);
  });

  scSocket.on('#authenticate', function (signedAuthToken, respond) {
    self.auth.verifyToken(signedAuthToken, self.verificationKey, self.defaultVerificationOptions, function (err, authToken) {
      scSocket.authToken = authToken || null;

      if (err && err.name == 'TokenExpiredError') {
        scSocket.deauthenticate();
      }

      var authError = self._processTokenError(scSocket, err, signedAuthToken);

      var authStatus = {
        isAuthenticated: !!authToken,
        authError: authError
      };

      if (authStatus.isAuthenticated) {
        scSocket.emit('authenticate', authToken);
      }

      // TODO: Maybe this should be passed back as a custom Error as first argument
      // We will have to change the frontend to not throw error when it receieves err as first argument
      // Treat authentication failure as a 'soft' error
      respond(null, authStatus);
    });
  });

  scSocket.on('#removeAuthToken', function () {
    var oldToken = scSocket.authToken;
    scSocket.authToken = null;
    scSocket.emit('deauthenticate', oldToken);
  });

  scSocket.once('_disconnect', function () {
    // TODO: Should we emit deauthenticate on disconnect?
    clearTimeout(scSocket._handshakeTimeout);
    scSocket.off('#handshake');
    scSocket.off('#authenticate');
    scSocket.off('#removeAuthToken');
    scSocket.off('authenticate');
    scSocket.off('deauthenticate');
  });

  scSocket._handshakeTimeout = setTimeout(this._handleHandshakeTimeout.bind(this, scSocket), this.ackTimeout);

  scSocket.once('#handshake', function (data, respond) {
    if (!data) {
      data = {};
    }
    var signedAuthToken = data.authToken;
    clearTimeout(scSocket._handshakeTimeout);

    self.auth.verifyToken(signedAuthToken, self.verificationKey, self.defaultVerificationOptions, function (err, authToken) {
      scSocket.authToken = authToken || null;

      if (err && err.name == 'TokenExpiredError') {
        scSocket.deauthenticate();
      }

      var authError;

      if (signedAuthToken != null) {
        authError = self._processTokenError(scSocket, err, signedAuthToken);
      }

      self.clients[id] = scSocket;
      self.clientsCount++;

      self._brokerEngine.bind(scSocket, function (err, sock, isWarning) {
        if (err) {
          // TODO: This should be an Error object with custom name
          var errorMessage = 'Failed to bind socket to io cluster - ' + err;
          scSocket.emit('#fail', errorMessage);
          scSocket.disconnect();
          if (isWarning) {
            self.emit('warning', errorMessage);
          } else {
            self.emit('error', new Error(errorMessage));
          }
          respond(err);

        } else {
          scSocket.state = scSocket.OPEN;
          scSocket.exchange = scSocket.global = self.exchange;

          self.emit('_connection', scSocket);
          self.emit('connection', scSocket);

          var status = {
            id: scSocket.id,
            isAuthenticated: !!authToken,
            pingTimeout: self.pingTimeout
          };

          if (authError) {
            status.authError = authError;
          }

          if (status.isAuthenticated) {
            scSocket.emit('authenticate', authToken);
          }

          // Treat authentication failure as a 'soft' error
          respond(null, status);
        }
      });

      scSocket.once('_disconnect', function () {
        delete self.clients[id];
        self.clientsCount--;

        self._brokerEngine.unbind(scSocket, function (err) {
          if (err) {
            // TODO: This needs to be a custom Error object with a name property
            self.emit('error', new Error('Failed to unbind socket from io cluster - ' + err));
          } else {
            self.emit('_disconnection', scSocket);
            self.emit('disconnection', scSocket);
          }
        });
      });
    });
  });
};

SCServer.prototype.close = function () {
  this.wsServer.close();
};

SCServer.prototype.getPath = function () {
  return this._path;
};

SCServer.prototype.generateId = function () {
  return base64id.generateId();
};

SCServer.prototype.on = function (event, listener) {
  if (event == 'ready') {
    this._brokerEngine.once(event, listener);
  } else {
    EventEmitter.prototype.on.apply(this, arguments);
  }
};

SCServer.prototype.removeListener = function (event, listener) {
  if (event == 'ready') {
    this._brokerEngine.removeListener(event, listener);
  } else {
    EventEmitter.prototype.removeListener.apply(this, arguments);
  }
};

SCServer.prototype.addMiddleware = function (type, middleware) {
  this._middleware[type].push(middleware);
};

SCServer.prototype.removeMiddleware = function (type, middleware) {
  var middlewareFunctions = this._middleware[type];

  this._middleware[type] = middlewareFunctions.filter(function (fn) {
    return fn != middleware;
  });
};

SCServer.prototype.verifyHandshake = function (info, cb) {
  var self = this;

  var req = info.req;
  var origin = info.origin;
  if (origin == 'null' || origin == null) {
    origin = '*';
  }
  var ok = false;

  if (this._allowAllOrigins) {
    ok = true;
  } else {
    try {
      var parts = url.parse(origin);
      parts.port = parts.port || 80;
      ok = ~this.origins.indexOf(parts.hostname + ':' + parts.port) ||
        ~this.origins.indexOf(parts.hostname + ':*') ||
        ~this.origins.indexOf('*:' + parts.port);
    } catch (e) {}
  }

  if (ok) {
    var handshakeMiddleware = this._middleware[this.MIDDLEWARE_HANDSHAKE];
    if (handshakeMiddleware.length) {
      var callbackInvoked = false;
      async.applyEachSeries(handshakeMiddleware, req, function (err) {
        if (callbackInvoked) {
          // TODO: Error object needs to be custom with a name property
          self.emit('warning', new Error('Callback for ' + self.MIDDLEWARE_HANDSHAKE + ' middleware was already invoked'));
        } else {
          callbackInvoked = true;
          if (err) {
            if (err === true) {
              err = new SilentMiddlewareBlockedError('Action was silently blocked by ' + self.MIDDLEWARE_HANDSHAKE + ' middleware', self.MIDDLEWARE_HANDSHAKE);
            } else if (self.middlewareEmitWarnings) {
              self.emit('warning', err);
            }
            cb(false, 401, err);
          } else {
            cb(true);
          }
        }
      });
    } else {
      cb(true);
    }
  } else {
    // TODO: Needs to be Error object with a name property
    var err = 'Failed to authorize socket handshake - Invalid origin: ' + origin;
    this.emit('warning', err);
    cb(false, 403, err);
  }
};

SCServer.prototype._isPrivateTransmittedEvent = function (event) {
  return !!event && event.indexOf('#') == 0;
};

SCServer.prototype.verifyInboundEvent = function (socket, event, data, cb) {
  var request = {
    socket: socket,
    event: event,
    data: data
  };

  var token = socket.getAuthToken();
  if (this._isAuthTokenExpired(token)) {
    request.authTokenExpiredError = new AuthTokenExpiredError('The socket auth token has expired');
    request.authTokenExpiredError.expiry = token.exp;

    socket.deauthenticate();
  }

  this._passThroughMiddleware(request, cb);
};

SCServer.prototype._isAuthTokenExpired = function (token) {
  if (token && token.exp != null) {
    var currentTime = Date.now();
    var expiryMilliseconds = token.exp * 1000;
    return currentTime > expiryMilliseconds;
  }
  return false;
};

SCServer.prototype._passThroughMiddleware = function (options, cb) {
  var self = this;

  var callbackInvoked = false;

  var request = {
    socket: options.socket
  };

  if (options.authTokenExpiredError != null) {
    request.authTokenExpiredError = options.authTokenExpiredError;
  }

  var event = options.event;

  if (this._isPrivateTransmittedEvent(event)) {
    if (event == this._subscribeEvent) {
      request.channel = options.data;

      async.applyEachSeries(this._middleware[this.MIDDLEWARE_SUBSCRIBE], request,
        function (err) {
          if (callbackInvoked) {
            // TODO: Error object needs to be custom with a name property
            self.emit('warning', new Error('Callback for ' + self.MIDDLEWARE_SUBSCRIBE + ' middleware was already invoked'));
          } else {
            callbackInvoked = true;
            if (err) {
              if (err === true) {
                err = new SilentMiddlewareBlockedError('Action was silently blocked by ' + self.MIDDLEWARE_SUBSCRIBE + ' middleware', self.MIDDLEWARE_SUBSCRIBE);
              } else if (self.middlewareEmitWarnings) {
                self.emit('warning', err);
              }
            }
            cb(err);
          }
        }
      );
    } else if (event == this._publishEvent) {
      if (this.allowClientPublish) {
        request.channel = options.data.channel;
        request.data = options.data.data;

        async.applyEachSeries(this._middleware[this.MIDDLEWARE_PUBLISH_IN], request,
          function (err) {
            if (callbackInvoked) {
              // TODO: Needs to be a custom Error with a name property
              self.emit('warning', new Error('Callback for ' + self.MIDDLEWARE_PUBLISH_IN + ' middleware was already invoked'));
            } else {
              callbackInvoked = true;
              if (err) {
                if (err === true) {
                  err =  new SilentMiddlewareBlockedError('Action was silently blocked by ' + self.MIDDLEWARE_PUBLISH_IN + ' middleware', self.MIDDLEWARE_PUBLISH_IN);
                } else if (self.middlewareEmitWarnings) {
                  self.emit('warning', err);
                }
                cb(err);
              } else {
                self.exchange.publish(request.channel, request.data, function (err) {
                  cb(err);
                });
              }
            }
          }
        );
      } else {
        cb(this.ERROR_NO_PUBLISH);
      }
    } else {
      // Do not allow blocking other reserved events or it could interfere with SC behaviour
      cb();
    }
  } else {
    request.event = event;
    request.data = options.data;

    async.applyEachSeries(this._middleware[this.MIDDLEWARE_EMIT], request,
      function (err) {
        if (callbackInvoked) {
          // TODO: Needs to be a custom Error with a name property
          self.emit('warning', new Error('Callback for ' + self.MIDDLEWARE_EMIT + ' middleware was already invoked'));
        } else {
          callbackInvoked = true;
          if (err) {
            if (err === true) {
              err = new SilentMiddlewareBlockedError('Action was silently blocked by ' + self.MIDDLEWARE_EMIT + ' middleware', self.MIDDLEWARE_EMIT);
            } else if (self.middlewareEmitWarnings) {
              self.emit('warning', err);
            }
          }
          cb(err);
        }
      }
    );
  }
};

SCServer.prototype.verifyOutboundEvent = function (socket, event, data, cb) {
  var self = this;

  var callbackInvoked = false;

  if (event == this._publishEvent) {
    var request = {
      socket: socket,
      channel: data.channel,
      data: data.data
    };
    async.applyEachSeries(this._middleware[this.MIDDLEWARE_PUBLISH_OUT], request,
      function (err) {
        if (callbackInvoked) {
          // TODO: Needs to be a custom Error with a name property
          self.emit('warning', new Error('Callback for ' + self.MIDDLEWARE_PUBLISH_OUT + ' middleware was already invoked'));
        } else {
          callbackInvoked = true;
          if (err) {
            if (err === true) {
              err = new SilentMiddlewareBlockedError('Action was silently blocked by ' + self.MIDDLEWARE_PUBLISH_OUT + ' middleware', self.MIDDLEWARE_PUBLISH_OUT);
            } else if (self.middlewareEmitWarnings) {
              self.emit('warning', err);
            }
            cb(err);
          } else {
            cb();
          }
        }
      }
    );
  } else {
    cb();
  }
};

module.exports = SCServer;
