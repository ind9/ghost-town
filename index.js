var cluster = require("cluster");
var events = require("events");
var _  = require("lodash");

var is = function (type, val, def) {
    return val !== null && typeof val === type ? val : def;
};

var Master = function (opts) {
    opts = is("object", opts, {});
    
    events.EventEmitter.call(this);
    
    this.isMaster = true;
    this.isRunning = false;
    
    this._workerCount = is("number", opts.workerCount, 4);
    this._workerQueue = [];
    
    this._itemTimeout = is("number", opts.pageDeath, 30000);
    this._itemRetries = is("number", opts.pageTries, -1);
    this._itemClicker = 0;
    this._itemQueue = [];
    this._items = {};
    
    cluster.on("exit", this._onExit.bind(this));
    
    this.start();
};

Master.prototype = Object.create(events.EventEmitter.prototype);

Master.prototype._onMessage = function (msg) {
    if (is("object", msg, {}).ghost !== "town") {
        return;
    }
    
    var item = this._items[msg.id];
    if (item) {
        delete this._items[msg.id];
        clearTimeout(item.timeout);
        item.done(msg.err, msg.data);
    }
    
    this._workerQueue.push(cluster.workers[msg.worker]);
    this._process();
};

Master.prototype._onTimeout = function (item) {
    delete this._items[item.id];
    
    if (item.retries === this._itemRetries) {
        item.done(new Error("[ghost-town] max pageTries"));
    } else {
        this.queue(item.data, true, item.done, item.retries + 1);
    }
};

Master.prototype._onExit = function (worker) {
    for (var id in this._items) {
        var item = this._items[id];
        
        if (item.worker === worker) {
            delete this._items[id];
            clearTimeout(item.timeout);
            this.queue(item.data, true, item.done, item.retries);
        }
    }
    
    if (this.isRunning) {
        cluster.fork().on("message", this._onMessage.bind(this));
    }
};

Master.prototype.start = function () {
    if (this.isRunning) {
        return;
    }
    
    this.isRunning = true;
    
    for (var i = this._workerCount; i--;) {
        this._onExit();
    }
};

Master.prototype.stop = function () {
    this.isRunning = false;
    
    for (var key in cluster.workers) {
        cluster.workers[key].kill();
    }
};

Master.prototype.queue = function (data, asap, next, tries) {
    var item = {
        id: this._itemClicker++,
        timeout: -1,
        retries: tries || 0,
        data: data,
        done: next || asap
    };
    
    this._itemQueue[next && asap ? "unshift" : "push"](item);
    this._process();
};

Master.prototype._process = function () {
    while (this._workerQueue.length && this._itemQueue.length) {
        var worker = this._workerQueue.shift();
        
        if (!worker || !worker.process.connected) {
            continue;
        }
        
        var item = this._itemQueue.shift();
        
        item.worker = worker;
        item.timeout = setTimeout(this._onTimeout.bind(this, item), this._itemTimeout);
        this._items[item.id] = item;
        worker.send({
            ghost: "town",
            id: item.id,
            data: item.data
        });
    }
};

var Worker = function (opts, clients) {
    opts = is("object", opts, {});
    
    events.EventEmitter.call(this);  
    var me = this;
    this.isMaster = false;
    
    this._workerDeath = is("number", opts.workerDeath, 25);
    this._workerShift = is("number", opts.workerShift, -1);
    
    this._pageCount = is("number", opts.pageCount, 1);
    this._pageClicker = 0;
    this._pages = {};

    _.forEach(clients, function(client, clientName){
        client.create()
        .then(function (proc) {
            for (var i = me._pageCount; i--;) {
                process.send({
                    ghost: "town",
                    worker: cluster.worker.id
                });
            }
        }.bind(this));
    })

    process.on("message", this._onMessage.bind(this, clients));
    
    if (this._workerShift !== -1) {
        setTimeout(this._exitProcess.bind(this, clients), this._workerShift);
    }
};

Worker.prototype = Object.create(events.EventEmitter.prototype);

Worker.prototype._exitProcess = function (clients){
    _.forEach(clients, function(client, clientName){
        client.exit({"onExit": process.exit});
    })
}

Worker.prototype._onMessage = function (clients, msg) {
    var me = this;
    if (is("object", msg, {}).ghost !== "town") {
        return;
    }
    var ajaxClient = msg.data.ajaxClient;
    if(!clients[ajaxClient]) return;
    clients[ajaxClient].createPage()
    .then(function(data){
        me._pageClicker++;
        me._pages[msg.id] = data.page;
        me.emit("queue", data.page, msg.data, me._done.bind(me, msg.id, clients[ajaxClient]));
    })
};

Worker.prototype._done = function (id, ajaxClient, err, data) {
    console.log("_done")
    if (!this._pages[id]) {
        return;
    }
    console.log(ajaxClient)
    if(ajaxClient.close)
        ajaxClient.close();
    delete this._pages[id];
    
    process.send({
        ghost: "town",
        worker: cluster.worker.id,
        id: id,
        err: err,
        data: data
    });
    if (this._pageClicker >= this._workerDeath) {
        this._exitProcess()
    }
};

module.exports = function (opts, clients) {
    return cluster.isMaster ? new Master(opts) : new Worker(opts, clients);
};