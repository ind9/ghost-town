var cluster = require("cluster");
var events = require("events");
var phantom = require("phantom");
var Nightmare = require("nightmare");
var shadowfax = require("shadowfax").default;

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
    var worker = cluster.workers[msg.worker]
    var item = this._items[msg.id];
    if (item) {
        delete this._items[msg.id];
        clearTimeout(item.timeout);
        item.done(msg.err, msg.data);
    }

    if(worker)
        worker.send({"ghost": "town","ack": true})

    if(msg.end)
        return
    
    this._workerQueue.push(cluster.workers[msg.worker]);
    this._process();
};

Master.prototype._onTimeout = function (item) {
    delete this._items[item.id];
    
    if (item.retries === this._itemRetries) {
        item.done(new Error("[ghost-town] max pageTries"));
        item.worker.send("exit")
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

var Worker = function (opts) {
    opts = is("object", opts, {});
    
    events.EventEmitter.call(this);  
    
    this.isMaster = false;
    
    this._workerDeath = is("number", opts.workerDeath, 25);
    this._workerShift = is("number", opts.workerShift, -1);
    
    this._pageCount = is("number", opts.pageCount, 1);
    this._pageClicker = 0;
    this._pages = {};

    //new phantom takes arguments as array
    if(opts.phantomFlags){
        var flags = []
        for(var flag in opts.phantomFlags){
            flags.push("--"+flag+"="+opts.phantomFlags[flag])
        }
    }

    if(opts.nightmareFlags){
        var self = this;
        Nightmare.action(
            'monitorRequest',
            function(name, options, parent, win, renderer, done) {
              win.webContents.session.webRequest.onBeforeRequest(
                [],
                function(details, callback) {
                    var blockMatch = details.url.match(new RegExp(options.blockedResources));
                    callback({cancel: blockMatch ? true : false})
                }
              );
              done();
            },
            function(done) {
              done();
              return this;
            }
        );
        opts.nightmareFlags.blockedResources = (opts.blockedResources || []).join('|');
        this.nightmare = function(options){
            var nightmareOpts = Object.assign({}, opts.nightmareFlags, options)
            self.nightmare = Nightmare(nightmareOpts)
            return self.nightmare
        }
        
    }
    phantom.create(flags).then(function (proc) {
        this.phantom = proc;
        
        for (var i = this._pageCount; i--;) {
            process.send({
                ghost: "town",
                worker: cluster.worker.id
            });
        }
    }.bind(this));

    if(opts.shadowfaxFlags){
        this.shadowfax = () => new shadowfax(opts.shadowfaxFlags)
    }

    process.on("message", this._onMessage.bind(this));
    
    if (this._workerShift !== -1) {
        setTimeout(this._exitProcess.bind(this), this._workerShift);
    }
};

Worker.prototype = Object.create(events.EventEmitter.prototype);

Worker.prototype._exitProcess = function (){
    this.phantom.exit()
    this.phantom.process.on("exit", () => {
        if(this.nightmare && !this.nightmare.ended && this.nightmare.proc){
            this.nightmare.proc.on("exit", () => {
                process.exit()
            })
            setInterval(this.nightmare._endNow.bind(this), 100)
        }
        else{
            process.exit()
        }
    })
}

Worker.prototype._onAck = function(){
    if (this._pageClicker >= this._workerDeath) {
        this._exitProcess()
    }
}

Worker.prototype._onMessage = function (msg) {
    if(msg === "exit"){
        return this._exitProcess()
    }
    if (is("object", msg, {}).ghost !== "town") {
        return;
    }
    if (is("object", msg, {}).ack) {
        return this._onAck()
    }
    var ajaxClient = msg.data.ajaxClient;
    switch(ajaxClient){
        case 'shadowfax':
            this._pageClicker++;
            this._pages[msg.id] = this.shadowfax;
            this.emit('queue', this.shadowfax, msg.data, this._done.bind(this, msg.id, 'shadowfax'));
        break;
        case 'nightmare':
            this._pageClicker++;
            this._pages[msg.id] = this.nightmare;
            this.emit("queue", this.nightmare, msg.data, this._done.bind(this, msg.id, 'nightmare'));
        break;
        default:
            this.phantom.createPage().then(function (page) {
                this._pageClicker++;
                this._pages[msg.id] = page;
                this.emit("queue", page, msg.data, this._done.bind(this, msg.id, 'phantom'));
            }.bind(this));
    }
};

Worker.prototype._done = function (id, ajaxClient, err, data) {
    if (!this._pages[id]) {
        return;
    }

    if(ajaxClient == 'phantom')
        this._pages[id].close();
    delete this._pages[id];
    
    process.send({
        ghost: "town",
        worker: cluster.worker.id,
        id: id,
        err: err,
        data: data,
        end: (this._pageClicker >= this.__workerDeath)
    });
    
};

module.exports = function (opts) {
    return cluster.isMaster ? new Master(opts) : new Worker(opts);
};