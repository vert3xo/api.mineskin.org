module.exports = function (app, config, optimus) {


    var SKIN_COUNTER = 1000000;

    var remoteFileSize = require("remote-file-size");
    var Util = require("../util");
    var http = require('http');
    var https = require('https');
    var fs = require('fs');
    var fileType = require("file-type");
    var imageSize = require("image-size");
    var tmp = require("tmp");
    tmp.setGracefulCleanup();
    var md5 = require("md5");
    var uuid = require("uuid/v4");
    var mongoose = require("mongoose");
    var request = require("request");

    var hasha = require("hasha");

    var imageHash = function (path, callback) {
        hasha.fromFile(path, {
            algorithm: "sha1"
        }).then(function (value) {
            callback(null, value);
        }).catch(function (reason) {
            callback(reason, null);
        })
    };


    var authentication = require("../generator/authentication");
    var dataFetcher = require("../generator/dataFetcher");
    var skinChanger = require("../generator/skinChanger");

    // Schemas
    var Account = require("../db/schemas/account").Account;
    var Skin = require("../db/schemas/skin").Skin;
    var Traffic = require("../db/schemas/traffic").Traffic;
    var Stat = require("../db/schemas/stat").Stat;


    app.post("/generate/url", function (req, res) {
        var url = req.body.url || req.query.url;
        var model = Util.validateModel(req.body.model || req.query.model || "steve");
        var visibility = parseInt(req.body.visibility || req.query.visibility) || 0;
        var name = req.body.name || req.query.name || "";

        console.log(req.body)
        console.log(req.query)

        console.log(("URL:        " + url).debug);
        console.log(("Model:      " + model).debug);
        console.log(("Visibility: " + visibility).debug);
        console.log(("Name:       " + name).debug);

        if (!url) {
            res.status(400).json({error: "URL is required"});
            return;
        }
        if (!url.startsWith("http")) {
            res.status(400).json({error: "Invalid URL"});
            return;
        }

        var genStart = Date.now();

        Util.checkTraffic(req, res).then(function (allowed, generatorDelay) {
            if (!allowed) return;

            remoteFileSize(url, function (err, remoteSize) {
                if (err) {
                    console.log(err);
                    return;
                }
                if (remoteSize <= 0 || remoteSize > 102400) {
                    res.status(400).json({error: "Invalid file size"});
                    return;
                }

                tmp.file(function (err, path, fd, fileCleanup) {
                    if (err) {
                        console.log(err);
                        return;
                    }

                    // var file = fs.createWriteStream(path);
                    request(url, {"encoding": "binary"}, function (err, response, body) {
                        if (err) {
                            console.log(err)
                            fileCleanup();
                            close(fd);
                            return;
                        }
                        if (response.statusCode < 200 || response.statusCode > 230) {
                            res.status(500).json({"error": "Failed to download image", code: response.statusCode});
                            fileCleanup();
                            close(fd);
                            return;
                        }
                        fs.writeFile(fd, response.body, "binary", function (err) {
                            if (err) {
                                console.log(err);
                                fileCleanup();
                                close(fd);
                                return;
                            }

                            imageHash(path, function (err, fileHash) {
                                if (err) {
                                    console.log(err)
                                    fileCleanup();
                                    close(fd);
                                    return;
                                }
                                console.log("Hash: " + fileHash);

                                skinChanger.findExistingSkin(fileHash, name, model, visibility, function (existingSkin) {
                                    if (existingSkin) {
                                        res.json(Util.skinToJson(existingSkin, generatorDelay));
                                        close(fd);
                                        fileCleanup();
                                    } else {
                                        var validImage = Util.validateImage(req, res, path);
                                        // cleanup();
                                        if (validImage) {
                                            skinChanger.getAvailableAccount(req, res, function (account) {
                                                Traffic.update({ip: req.realAddress}, {lastRequest: new Date()}, {upsert: true}, function (err, traffic) {
                                                    if (err) {
                                                        console.log(err)
                                                        fileCleanup();
                                                        close(fd);
                                                        return;
                                                    }
                                                    skinChanger.generateUrl(account, url, model, function (result, errorCause) {
                                                        close(fd);
                                                        fileCleanup();
                                                        if (result === true) {
                                                            account.errorCounter = 0;
                                                            if (!account.successCounter) account.successCounter = 0;
                                                            account.successCounter++;
                                                            account.save(function (err, account) {
                                                                if (err) return console.log(err);
                                                                getAndSaveSkinData(account, {
                                                                    type: "url",
                                                                    model: model,
                                                                    visibility: visibility,
                                                                    name: name,
                                                                    via: (req.headers["referer"] && req.headers["referer"].indexOf("mineskin.org") > -1) ? "website" : "api",
                                                                    ua: req.headers["user-agent"]
                                                                }, fileHash, uuid(), genStart, function (err, skin) {
                                                                    if (err) {
                                                                        var reason = "skin_data_fetch_failed";
                                                                        res.status(500).json({error: "Failed to get skin data", err: err, accountId: account.id, reason: reason});
                                                                        console.log(("Failed to download skin data").warn)

                                                                        console.log(("=> FAIL #" + account.errorCounter + "\n").red);
                                                                        logFail(account, "url", reason);
                                                                    } else {
                                                                        res.json(Util.skinToJson(skin, generatorDelay));

                                                                        console.log("=> SUCCESS\n".green);
                                                                        logSuccess(account, "url");
                                                                    }
                                                                })
                                                            })
                                                        } else {
                                                            var reason = errorCause || "skin_data_generation_failed";
                                                            res.status(500).json({error: "Failed to generate skin data", err: result, accountId: account.id, reason: reason});
                                                            console.log(("Failed to generate skin data").warn)

                                                            console.log(("=> FAIL #" + account.errorCounter + "\n").red);
                                                            logFail(account, "url", reason);
                                                        }
                                                    })
                                                })
                                            })
                                        }
                                    }
                                })
                            })
                        })
                    });
                })
            });
        })
    })

    app.post("/generate/upload", function (req, res) {
        if (!req.files) {
            res.status(400).json({error: "Missing files"});
            return;
        }
        var model = Util.validateModel(req.body.model || req.query.model || "steve");
        var visibility = parseInt(req.body.visibility || req.query.visibility) || 0;
        var name = req.body.name || req.query.name || "";

        console.log(req.body)
        console.log(req.query)

        console.log(("FILE:       " + req.files.file).debug);
        console.log(("Model:      " + model).debug);
        console.log(("Visibility: " + visibility).debug);
        console.log(("Name:       " + name).debug);

        var fileUpload = req.files.file;
        if (!fileUpload) {
            res.status(400).json({error: "Missing file"});
            return;
        }

        var genStart = Date.now();

        Util.checkTraffic(req, res).then(function (allowed, generatorDelay) {
            if (!allowed) return;

            tmp.file(function (err, path, fd, fileCleanup) {
                if (err) {
                    console.log(err);
                    return;
                }

                fileUpload.mv(path, function (err) {
                    if (err) {
                        console.log(err)
                        fileCleanup();
                        close(fd);
                        return;
                    }
                    imageHash(path, function (err, fileHash) {
                        if (err) {
                            console.log(err)
                            fileCleanup();
                            close(fd);
                            return;
                        }
                        console.log("Hash: " + fileHash);

                        skinChanger.findExistingSkin(fileHash, name, model, visibility, function (existingSkin) {
                            if (existingSkin) {
                                res.json(Util.skinToJson(existingSkin, generatorDelay));
                                close(fd);
                                fileCleanup();
                            } else {
                                fs.readFile(path, function (err, buf) {
                                    if (err) {
                                        console.log(err)
                                        fileCleanup();
                                        close(fd);
                                        return;
                                    }


                                    var validImage = Util.validateImage(req, res, path);
                                    // cleanup();
                                    if (validImage) {
                                        skinChanger.getAvailableAccount(req, res, function (account) {
                                            Traffic.update({ip: req.realAddress}, {lastRequest: new Date()}, {upsert: true}, function (err, traffic) {
                                                if (err) {
                                                    console.log(err)
                                                    fileCleanup();
                                                    close(fd);
                                                    return;
                                                }
                                                skinChanger.generateUpload(account, buf, model, function (result, errorCause) {
                                                    close(fd);
                                                    fileCleanup();
                                                    if (result === true) {
                                                        account.errorCounter = 0;
                                                        if (!account.successCounter) account.successCounter = 0;
                                                        account.successCounter++;
                                                        account.save(function (err, account) {
                                                            if (err) return console.log(err);
                                                            getAndSaveSkinData(account, {
                                                                type: "upload",
                                                                model: model,
                                                                visibility: visibility,
                                                                name: name,
                                                                via: (req.headers["referer"] && req.headers["referer"].indexOf("mineskin.org") > -1) ? "website" : "api",
                                                                ua: req.headers["user-agent"]
                                                            }, fileHash, uuid(), genStart, function (err, skin) {
                                                                if (err) {
                                                                    var reason = "skin_data_fetch_failed";
                                                                    res.status(500).json({error: "Failed to get skin data", err: err, accountId: account.id, reason: reason});
                                                                    console.log(("Failed to download skin data").warn)

                                                                    console.log(("=> FAIL #" + account.errorCounter + "\n").red);
                                                                    logFail(account, "upload", reason);
                                                                } else {
                                                                    res.json(Util.skinToJson(skin, generatorDelay));

                                                                    console.log("=> SUCCESS\n".green);
                                                                    logSuccess(account, "upload");
                                                                }
                                                            });
                                                        })
                                                    } else {
                                                        var reason = errorCause || "skin_data_generation_failed";
                                                        res.status(500).json({error: "Failed to upload skin data (" + result + ")", err: result, accountId: account.id, reason: reason});
                                                        console.log(("Failed to upload skin data").warn)

                                                        console.log(("=> FAIL #" + account.errorCounter + "\n").red);
                                                        logFail(account, "upload", reason);
                                                    }
                                                })
                                            })
                                        })
                                    }
                                });
                            }
                        })
                    });
                })
            })
        })
    });

    app.get("/generate/user/:uuid", function (req, res) {
        var visibility = parseInt(req.body.visibility || req.query.visibility) || 0;
        var name = req.body.name || req.query.name || "";
        var uuid = req.params.uuid;

        console.log(("USER:       " + uuid).debug);
        console.log(("Visibility: " + visibility).debug);
        console.log(("Name:       " + name).debug);

        var shortUuid = uuid;
        var longUuid = uuid;
        if (shortUuid.indexOf("-") > -1) {
            shortUuid = shortUuid.replace(/-/g, "");
        }
        if (longUuid.indexOf("-") < 0) {
            longUuid = longUuid.substring(0, 8) + "-" + longUuid.substring(8, 8 + 4) + "-" + longUuid.substring(12, 12 + 4) + "-" + longUuid.substring(16, 16 + 4) + "-" + longUuid.substring(20, 20 + 12);
        }

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(longUuid)) {
            res.status(400).json({error: "Invalid UUID"});
            return;
        }

        var genStart = Date.now();

        Util.checkTraffic(req, res).then(function (allowed, generatorDelay) {
            if (!allowed) return;
            Skin.findOne({uuid: longUuid, name: name, visibility: visibility}, function (err, skin) {
                if (err) return console.log(err);
                if (skin) {// Skin already generated
                    var time = Date.now() / 1000;
                    if (skin.time > time - 1800) {// Wait 30 minutes before generating again
                        skin.duplicate += 1;
                        skin.save(function (err, skin) {
                            if (err) return console.log(err);

                            res.json(Util.skinToJson(skin, generatorDelay));
                        })
                        return;
                    }
                }

                // Don't generate anything, just need to get the user's live skin data

                getAndSaveSkinData({uuid: shortUuid}, {
                    type: "user",
                    model: "unknown",
                    visibility: visibility,
                    name: name,
                    via: (req.headers["referer"] && req.headers["referer"].indexOf("mineskin.org") > -1) ? "website" : "api",
                    ua: req.headers["user-agent"]
                }, function (skinTexture, cb) {// Generate the file hash from the skin's texture url
                    if (!skinTexture) return;
                    tmp.file(function (err, path, fd, fileCleanup) {
                        if (err) {
                            console.log(err);
                            return;
                        }

                        var file = fs.createWriteStream(path);
                        console.log("Downloading user texture from " + skinTexture.url + " to " + path);
                        request(skinTexture.url).pipe(file)
                            .on("error", function (err) {
                                if (err) {
                                    console.log(err)
                                    fileCleanup();
                                    close(fd);
                                    return;
                                }
                            })
                            .on("close", function () {
                                imageHash(path, function (err, fileHash) {
                                    if (err) {
                                        console.log(err)
                                        fileCleanup();
                                        close(fd);
                                        return;
                                    }
                                    console.log("Hash: " + fileHash);


                                    cb(fileHash);
                                    close(fd);
                                    fileCleanup();
                                });
                            });
                    })
                }, longUuid, genStart, function (err, skin) {
                    if (err) {
                        var reason = "skin_data_fetch_failed";
                        res.status(500).json({error: "Failed to get skin data", err: err, reason: reason});
                        console.log(("Failed to download skin data").warn)

                        console.log(("=> FAIL\n").red);
                        logFail(null, "user", reason);
                    } else {
                        res.json(Util.skinToJson(skin, generatorDelay));

                        console.log("=> SUCCESS\n".green);
                        logSuccess(null, "user");
                    }
                })
            })
        })
    });

    // fileHash can either be the hash, or a callback to get the hash
    function getAndSaveSkinData(account, options, fileHash, uuid, genStart, cb) {
        dataFetcher.getSkinData(account, function (err, skinData) {
            if (err) {
                console.log(err)
                cb(err, null);
                return;
            }
            console.log(JSON.stringify(skinData).debug);
            if (!skinData) {
                cb("Skin data is empty", null);
                return;
            }

            var textures = JSON.parse(new Buffer(skinData.value, 'base64').toString('utf8')).textures;
            console.log(JSON.stringify(textures).debug);
            var skinTexture = textures.SKIN;
            var capeTexture = textures.CAPE || {url: undefined};
            console.log("Skin: " + JSON.stringify(skinTexture));
            console.log("Cape: " + JSON.stringify(capeTexture));

            if (!skinTexture || !skinTexture.url) {
                cb("Skin texture is null", null);
                return;
            }

            // check for duplicates again, this time using the skin's URL
            Skin.findOne({name: options.name, visibility: options.visibility, url: skinTexture.url}, function (err, skin) {
                if (skin) {// skin with that url already exists
                    console.log("[Generator] Found duplicate skin with same URL");

                    skin.duplicate += 1;
                    skin.save(function (err, skin) {
                        if (err) return console.log(err);

                        cb(null, skin);
                    });
                } else {
                    var fileHashCallback = function (fileHash) {
                        var rand = Math.ceil((Date.now() - 1500000000000) + Math.random());
                        var newId = optimus.encode(rand);
                        var skin = new Skin({
                            // '_id': mongoose.Types.ObjectId(md5(fileHash + options.name + Date.now())),
                            id: newId,
                            hash: fileHash,
                            name: options.name,
                            model: options.model,
                            visibility: options.visibility,
                            uuid: uuid,
                            value: skinData.value,
                            signature: skinData.signature,
                            url: skinTexture.url,
                            capeUrl: capeTexture.url,
                            time: Date.now() / 1000,
                            generateDuration: Date.now() - genStart,
                            account: account.id,
                            type: options.type,
                            duplicate: 0,
                            views: 1,
                            via: options.via || "api",//TODO,
                            server: config.server || "default",
                            ua: options.ua,
                            apiVer: "node"
                        });
                        skin.save(function (err, skin) {
                            if (err) return console.log(err);
                            console.log(("[Generator] New Skin saved (#" + skin.id + "). Generated in " + (Date.now() - genStart) + "ms").info);
                            cb(null, skin);
                        })
                    };

                    if (typeof fileHash === "function") {
                        fileHash(skinTexture, fileHashCallback);
                    } else {
                        fileHashCallback(fileHash);
                    }
                }
            });
        })
    }


    function logFail(account, generateType, errorCause) {
        increaseStat("generate.fail");

        if (account) {
            if (account.errorCounter > 0 && account.errorCounter % 10 === 0) {
                Util.postDiscordMessage("⚠️ Account #" + account.id + " has " + account.errorCounter + " errors!\n  Latest Type: " + generateType + "\n  Latest Cause: " + errorCause);
            }

            if (account.discordUser && account.errorCounter > 0 && account.errorCounter >= config.errorThreshold) {
                var emailSplit = account.username.split("\@");
                Util.sendDiscordDirectMessage("Hi there!\n" +
                    "This is an automated notification that a MineSkin account you linked to your Discord profile has been disabled since it failed to properly generate skin data recently.\n" +
                    "  Affected Account: " + (account.playername || account.uuid) + " (" + emailSplit[0].substr(0, 3) + "***@" + emailSplit[1] + ")\n" +
                    "  Last Error Code:  " + account.lastErrorCode + "\n" +
                    "\n" +
                    "The account won't be used for skin generation until the issues are resolved.\n" +
                    "Please make sure the configured credentials & security questions are correct at https://mineskin.org/account\n" +
                    "For further assistance feel free to ask in <#482181024445497354> 🙂", account.discordUser);
            }

            account.lastErrorCode = errorCause;
            account.save();
        }

        if (errorCause === "cloudfront_unauthorized") {
            Util.postDiscordMessage("🛑 Account #" + account.id + " received a CloudFront Unauthorized Response! Panic!");
        }

        fs.appendFileSync("generateStatus.log", "[" + new Date().toUTCString() + "] FAIL [A" + (account ? account.id : "-1") + "/" + generateType + "] (" + errorCause + ")\n", "utf8");
    }

    function logSuccess(account, generateType) {
        increaseStat("generate.success");


        fs.appendFileSync("generateStatus.log", "[" + new Date().toUTCString() + "] SUCCESS [A" + (account ? account.id : "-1") + "/" + generateType + "]\n", "utf8");
    }

    function increaseStat(key, amount, cb) {
        if (!amount) amount = 1;


        Stat.findOne({key: key}, function (err, stat) {
            if (err) return console.log(err);
            if (!stat) {
                return console.warn("Invalid Stat key: " + key);
            }
            stat.value += amount;
            stat.save(cb);
        });

    }

    function close(fd){
        try{
            fs.closeSync(fd);
        }catch (e) {
            console.log(e);
        }
    }

};
