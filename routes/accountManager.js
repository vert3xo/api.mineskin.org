module.exports = function (app, config) {

    var util = require("../util");
    var urls = require("../generator/urls");
    var request = require("request").defaults({
        headers: {
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate",
            "Origin": "mojang://launcher",
            "User-Agent": "MineSkin.org" /*"Minecraft Launcher/2.1.2481 (bcb98e4a63) Windows (10.0; x86_64)"*/,
            "Content-Type": "application/json;charset=UTF-8"
        }
    });
    var md5 = require("md5");

    var pendingDiscordLinks = {};

    // Schemas
    var Account = require("../db/schemas/account").Account;
    var Skin = require("../db/schemas/skin").Skin;


    app.get("/accountManager/myAccount", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.query.username) {
            res.status(400).json({error: "Missing login data"});
            return;
        }

        Account.findOne({username: req.query.username, type: "external"}, "username uuid lastUsed enabled hasError lastError successCounter errorCounter").lean().exec(function (err, account) {
            if (err) return console.log(err);
            if (!account) {
                res.status(404).json({error: "Account not found"})
                return;
            }

            getUser(req.query.token, function (response, body) {
                if (body.error) {
                    res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
                } else {
                    if (body.username !== req.query.username) {
                        res.status(400).json({error: "username mismatch"})
                        return;
                    }

                    var generateTotal = account.successCounter + account.errorCounter;
                    res.json({
                        username: account.username,
                        uuid: account.uuid,
                        lastUsed: account.lastUsed,
                        enabled: account.enabled,
                        hasError: account.hasError,
                        lastError: account.lastError,
                        successRate: Number((account.successCounter / generateTotal).toFixed(3))
                    })
                }
            })
        });

    });

    app.post("/accountManager/auth/login", function (req, res) {
        if (!req.body.username || !req.body.password) {
            res.status(400).json({error: "Missing login data"});
            return;
        }
        var remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        console.log(("[Auth] POST " + urls.authenticate).debug);
        var body = {
            agent: {
                name: "Minecraft",
                version: 1
            },
            username: req.body.username,
            password: new Buffer(req.body.password, "base64").toString("ascii"),
            clientToken: md5(req.body.username + "_" + remoteIp),
            requestUser: true
        };
        console.log(("[Acc] " + JSON.stringify(body)).debug);
        request({
            method: "POST",
            url: urls.authenticate,
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": remoteIp,
                "REMOTE_ADDR": remoteIp
            },
            json: true,
            body: body
        }, function (err, response, body) {
            console.log("Auth Body:".debug)
            console.log(("" + JSON.stringify(body)).debug);
            if (err) {
                res.status(500).json({error: body})
                return console.log(err);
            }
            if (body.error) {
                console.error(body);
                res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
            } else {
                res.json({
                    success: !!body.accessToken,
                    token: body.accessToken
                })
            }
        })
    });

    app.post("/accountManager/auth/getChallenges", function (req, res) {
        if (!req.body.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        var remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        console.log(("[Auth] GET " + urls.security.location).debug);
        request({
            url: urls.security.location,
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + req.body.token,
                "X-Forwarded-For": remoteIp,
                "REMOTE_ADDR": remoteIp
            }
        }, function (err, response, body) {
            if (err) return console.log(err);

            if (!response || response.statusCode < 200 || response.statusCode > 230) {// Not yet answered
                // Get the questions
                console.log(("[Auth] GET " + urls.security.challenges).debug);
                request({
                    url: urls.security.challenges,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + req.body.token,
                        "X-Forwarded-For": remoteIp,
                        "REMOTE_ADDR": remoteIp
                    }
                }, function (err, response, body) {
                    if (err) return console.log(err);

                    var questions = JSON.parse(body);
                    res.json({
                        success: true,
                        needToSolveChallenges: questions && questions.length > 0,
                        status: "ok",
                        questions: questions,
                        msg: "Got security questions"
                    })
                })
            } else {
                res.json({
                    success: true,
                    needToSolveChallenges: false,
                    status: "ok",
                    msg: "Challenges already solved"
                })
            }
        })
    });

    app.post("/accountManager/auth/solveChallenges", function (req, res) {
        if (!req.body.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.body.securityAnswer && !req.body.securityAnswers) {
            res.status(400).json({error: "Missing security answer(s)"})
            return;
        }
        if (typeof req.body.securityAnswers !== "undefined") {
            if (!validateMultiSecurityAnswers(req.body.securityAnswers, req, res)) return;
        }
        var remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        var answers = req.body.securityAnswers;

        // Post answers
        console.log(("[Auth] POST " + urls.security.location).debug);
        request({
            method: "POST",
            url: urls.security.location,
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + req.body.token,
                "X-Forwarded-For": remoteIp,
                "REMOTE_ADDR": remoteIp
            },
            json: answers
        }, function (err, response, body) {
            if (err) return console.log(err);

            if (response.statusCode >= 200 && response.statusCode < 300) {
                res.json({
                    success: true,
                    status: "ok",
                    msg: "Challenges solved"
                })
            } else {
                res.json({
                    success: false,
                    status: "err",
                    error: body.error,
                    msg: body.errorMessage
                })
            }
        })
    })

    app.get("/accountManager/auth/user", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }

        getUser(req.query.token, function (response, body) {
            if (body.error) {
                console.error(body);
                res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
            } else {
                res.json({
                    id: body.id,
                    username: body.username,
                    legacyUser: body.legacyUser
                })
            }
        })
    })

    app.get("/accountManager/auth/userProfile", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }

        getProfile(req.query.token, function (response, body) {
            if (body.error) {
                console.error(body.error);
                res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
            } else {
                res.json({
                    uuid: body.id,
                    name: body.name,
                    legacyProfile: body.legacyProfile,
                    suspended: body.suspended
                })
            }
        })
    })

    app.get("/accountManager/accountStatus", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.query.username) {
            res.status(400).json({error: "Missing username"});
            return;
        }
        if (!req.query.uuid) {
            res.status(400).json({error: "Missing UUID"})
            return;
        }

        Account.findOne({username: req.query.username, uuid: req.query.uuid, type: "external"}, "enabled password security multiSecurity discordUser", function (err, acc) {
            if (err) return console.log(err);
            console.log(acc);

            if (acc) {
                getUser(req.query.token, function (response, userBody) {
                    if (userBody.error) {
                        res.status(response.statusCode).json({error: userBody.error, msg: userBody.errorMessage})
                    } else {
                        if (userBody.username.toLowerCase() !== req.query.username.toLowerCase()) {
                            res.status(400).json({error: "username mismatch"})
                            return;
                        }
                        if (req.query.password) {
                            acc.passwordNew = util.crypto.encrypt(new Buffer(req.query.password, "base64").toString("ascii"));
                        }
                        if (req.query.security) {
                            if (req.query.security.startsWith("[") && req.query.security.endsWith("]")) {
                                var sec = JSON.parse(req.query.security);
                                if (!validateMultiSecurityAnswers(sec, req, res)) return;
                                acc.multiSecurity = sec;
                            } else {
                                acc.security = req.query.security;
                            }
                        }
                        acc.save(function (err, acc) {
                            res.json({
                                exists: !!acc,
                                enabled: !!acc && acc.enabled,
                                passwordUpdated: !!req.query.password,
                                securityUpdated: !!req.query.security,
                                discordLinked: !!acc && !!acc.discordUser
                            });
                        });
                    }
                });
            } else {
                res.json({
                    exists: !!acc,
                    enabled: !!acc && acc.enabled,
                    discordLinked: !!acc && acc.discordUser
                });
            }
        })
    });

    app.get("/accountManager/accountStats", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.query.username) {
            res.status(400).json({error: "Missing username"})
            return;
        }
        if (!req.query.uuid) {
            res.status(400).json({error: "Missing UUID"})
            return;
        }

        getUser(req.query.token, function (response, userBody) {
            if (userBody.error) {
                res.status(response.statusCode).json({error: userBody.error, msg: userBody.errorMessage})
            } else {
                if (userBody.username.toLowerCase() !== req.query.username.toLowerCase()) {
                    res.status(400).json({error: "username mismatch"})
                    return;
                }

                Account.findOne({username: req.query.username, uuid: req.query.uuid}, "id", function (err, account) {
                    if (err) return console.log(err);
                    if (!account) {
                        res.status(404).json({error: "Account not found"})
                        return;
                    }

                    Skin.count({account: account.id}, function (err, count) {
                        if (err) {
                            console.warn(err);
                            return;
                        }
                        res.json({
                            success: true,
                            generateCount: count
                        });
                    });
                })
            }
        })
    });

    app.post("/accountManager/confirmAccountSubmission", function (req, res) {
        if (!req.body.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.body.username || !req.body.password) {
            res.status(400).json({error: "Missing login data"});
            return;
        }
        if (!req.body.uuid) {
            res.status(400).json({error: "Missing UUID"})
            return;
        }
        if (typeof req.body.securityAnswer === "undefined" && typeof req.body.securityAnswers === "undefined" && !req.body.skipSecurityChallenges) {
            res.status(400).json({error: "Missing security answer(s)"})
            return;
        }

        if (typeof req.body.securityAnswers !== "undefined") {
            if (!validateMultiSecurityAnswers(req.body.securityAnswers, req, res)) return;
        }

        var remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        Account.findOne({username: req.body.username}, function (err, acc) {
            if (err) return console.log(err);
            if (acc) {
                res.status(400).json({error: "Account already exists"})
                return;
            }

            // Just some server-side validation
            getUser(req.body.token, function (response, body) {
                if (body.error) {
                    res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
                } else {
                    if (body.username.toLowerCase() !== req.body.username.toLowerCase()) {
                        res.status(400).json({error: "username mismatch"})
                        return;
                    }
                    if (body.legacyUser) {
                        res.status(400).json({error: "cannot add legacy user"})
                        return;
                    }

                    getProfile(req.body.token, function (response, body) {
                        if (body.error) {
                            res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
                        } else {
                            if (body.id !== req.body.uuid) {
                                res.status(400).json({error: "uuid mismatch"})
                                return;
                            }
                            if (body.legacyUser) {
                                res.status(400).json({error: "cannot add legacy profile"})
                                return;
                            }
                            if (body.suspended) {
                                res.status(400).json({error: "cannot add suspended profile"})
                                return;
                            }

                            Account.aggregate([
                                { $match: { enabled: true, errorCounter: {$lt: 10} } },
                                { $group : { _id : '$requestServer', count : {$sum : 1}}},
                                { $sort : { count : 1 } }
                            ], function (err, accountsPerServer) {
                                if (err) {
                                    console.warn("Failed to get accounts per server");
                                    console.log(err);
                                }
                                var requestServer = accountsPerServer ? accountsPerServer[0]["_id"] : null;

                                // Save the new account!
                                Account.findOne({}).sort({id: -1}).exec(function (err, last) {
                                    if (err) return console.log(err);
                                    var lastId = last.id;

                                    var account = new Account({
                                        id: lastId + 1,
                                        username: req.body.username,
                                        passwordNew: util.crypto.encrypt(req.body.password),
                                        security: req.body.securityAnswer || "",
                                        multiSecurity: req.body.securityAnswers || [],
                                        uuid: req.body.uuid,
                                        accessToken: req.body.token,
                                        clientToken: md5(req.body.username + "_" + remoteIp),
                                        type: "external",
                                        enabled: true,
                                        lastUsed: 0,
                                        forcedTimeoutAt: 0,
                                        errorCounter: 0,
                                        successCounter: 0,
                                        requestServer: requestServer || null,
                                        timeAdded: Math.round(Date.now() / 1000),
                                        requestIp: remoteIp
                                    });
                                    account.save(function (err, account) {
                                        if (err) {
                                            res.status(500).json({
                                                error: err,
                                                msg: "Failed to save account"
                                            });
                                            return console.log(err);
                                        }
                                        res.json({
                                            success: true,
                                            msg: "Account saved. Thanks for your contribution!"
                                        })
                                    })
                                });
                            })
                        }
                    })
                }
            })
        });


    })

    app.post("/accountManager/settings/status", function (req, res) {
        if (!req.body.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.body.username) {
            res.status(400).json({error: "Missing username"})
            return;
        }
        if (typeof req.body.enabled === "undefined") {
            res.status(400).json({error: "Missing enabled-status"})
            return;
        }

        getUser(req.body.token, function (response, body) {
            if (body.error) {
                res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
            } else {
                if (body.username.toLowerCase() !== req.body.username.toLowerCase()) {
                    res.status(400).json({error: "username mismatch"})
                    return;
                }

                Account.findOne({username: req.body.username}, function (err, account) {
                    if (err) return console.log(err);
                    if (!account) {
                        res.status(404).json({error: "Account not found"})
                        return;
                    }

                    account.enabled = !!req.body.enabled;
                    account.save(function (err, account) {
                        if (err) return console.log(err);
                        res.json({
                            success: true,
                            msg: "Account status updated",
                            enabled: account.enabled
                        })
                    });
                })
            }
        })
    })

    app.post("/accountManager/deleteAccount", function (req, res) {
        if (!req.body.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.body.username) {
            res.status(400).json({error: "Missing username"})
            return;
        }
        if (!req.body.uuid) {
            res.status(400).json({error: "Missing UUID"})
            return;
        }

        getUser(req.body.token, function (response, body) {
            if (body.error) {
                res.status(response.statusCode).json({error: body.error, msg: body.errorMessage})
            } else {
                if (body.username.toLowerCase() !== req.body.username.toLowerCase()) {
                    res.status(400).json({error: "username mismatch"})
                    return;
                }

                Account.findOne({username: req.body.username, uuid: req.body.uuid, enabled: false}, "id", function (err, account) {
                    if (err) return console.log(err);
                    if (!account) {
                        res.status(404).json({error: "Account not found"})
                        return;
                    }

                    account.remove(function (err, account) {
                        if (err) return console.log(err);
                        res.json({
                            success: true,
                            msg: "Account removed"
                        })
                    });
                })
            }
        })
    })

    app.get("/accountManager/listAccounts", function (req, res) {
        Account.find({}, "id lastUsed enabled errorCounter successCounter type", function (err, accounts) {
            if (err) return console.log(err);

            var accs = [];
            accounts.forEach(function (acc) {
                if (!acc.successCounter) acc.successCounter = 0;
                if (!acc.errorCounter) acc.errorCounter = 0;
                var total = acc.successCounter + acc.errorCounter;
                accs.push({
                    id: acc.id,
                    lastUsed: acc.lastUsed,
                    enabled: acc.enabled,
                    type: acc.type,
                    successRate: Number((acc.successCounter / total).toFixed(3))
                })
            });
            res.json(accs)
        })
    })

    app.get("/accountManager/discord/oauth/start", function (req, res) {
        if (!req.query.token) {
            res.status(400).json({error: "Missing token"})
            return;
        }
        if (!req.query.username) {
            res.status(400).json({error: "Missing username"})
            return;
        }
        if (!req.query.uuid) {
            res.status(400).json({error: "Missing UUID"})
            return;
        }

        getUser(req.query.token, function (response, userBody) {
            if (userBody.error) {
                res.status(response.statusCode).json({error: userBody.error, msg: userBody.errorMessage})
            } else {
                if (userBody.username.toLowerCase() !== req.query.username.toLowerCase()) {
                    res.status(400).json({error: "username mismatch"})
                    return;
                }

                Account.findOne({username: req.query.username, uuid: req.query.uuid}, "id username uuid", function (err, account) {
                    if (err) return console.log(err);
                    if (!account) {
                        res.status(404).json({error: "Account not found"})
                        return;
                    }

                    var clientId = config.discord.oauth.id;
                    var redirect = encodeURIComponent("https://"+(config.server?config.server+".":"")+"api.mineskin.org/accountManager/discord/oauth/callback");

                    var state = md5(account.uuid + "_" + account.username + "_magic_discord_string_" + Date.now() + "_" + account.id);

                    pendingDiscordLinks[state] = {
                        account: account.id,
                        uuid: account.uuid
                    };

                    res.redirect('https://discordapp.com/api/oauth2/authorize?client_id=' + clientId + '&scope=identify&response_type=code&state=' + state + '&redirect_uri=' + redirect);
                })
            }
        })
    });

    app.get("/accountManager/discord/oauth/callback", function (req, res) {
        if (!req.query.code) {
            res.status(400).json({
                error: "Missing code"
            });
            return;
        }
        var redirect = "https://"+(config.server?config.server+".":"")+"api.mineskin.org/accountManager/discord/oauth/callback";
        request({
            url: "https://discordapp.com/api/oauth2/token",
            method: "POST",
            form: {
                client_id: config.discord.oauth.id,
                client_secret: config.discord.oauth.secret,
                grant_type: "authorization_code",
                code: req.query.code,
                redirect_uri: redirect,
                scope: "identify"
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            gzip: true,
            json: true
        }, function (err, tokenResponse, tokenBody) {
            if (err) {
                console.warn(err);
                res.status(500).json({
                    error: "Discord API error",
                    state: "oauth_token"
                });
                return;
            }

            console.log(tokenBody);
            if (!tokenBody.access_token) {
                res.status(500).json({
                    error: "Discord API error",
                    state: "oauth_access_token"
                });
                return;
            }

            request({
                url: "https://discordapp.com/api/users/@me",
                method: "GET",
                auth: {
                    bearer: tokenBody.access_token
                },
                gzip: true,
                json: true
            }, function (err, profileResponse, profileBody) {
                if (err) {
                    console.warn(err);
                    res.status(500).json({
                        error: "Discord API error",
                        state: "profile"
                    });
                    return;
                }

                if (!req.query.state) {
                    res.status(400).json({
                        error: "Missing state"
                    });
                    return;
                }
                if (!pendingDiscordLinks.hasOwnProperty(req.query.state)) {
                    console.warn("Got a discord OAuth callback but the API wasn't expecting that linking request");
                    res.status(400).json({
                        error: "API not waiting for this link"
                    });
                    return;
                }
                var linkInfo = pendingDiscordLinks[req.query.state];
                delete pendingDiscordLinks[req.query.state];

                console.log(profileBody);

                if (!profileBody.id) {
                    res.status(404).json({error: "Missing profile id in discord response"})
                    return;
                }

                Account.findOne({id: linkInfo.account, uuid: linkInfo.uuid}, function (err, account) {
                    if (err) return console.log(err);
                    if (!account) {
                        res.status(404).json({error: "Account not found"})
                        return;
                    }

                    if (account.discordUser) {
                        console.warn("Account #" + account.id + " already has a linked discord user (#" + account.discordUser + "), changing to " + profileBody.id);
                    }

                    account.discordUser = profileBody.id;
                    account.save(function (err, acc) {
                        if (err) {
                            console.warn(err);
                            res.status(500).json({error: "Unexpected error"})
                            return;
                        }

                        console.log("Linking Discord User " + profileBody.username + "#" + profileBody.discriminator + " to Mineskin account #" + linkInfo.account + "/" + linkInfo.uuid);
                        addDiscordRole(profileBody.id, function (b) {
                            if (b) {
                                res.json({
                                    success: true,
                                    msg: "Successfully linked Mineskin Account " + account.uuid + " to Discord User " + profileBody.username + "#" + profileBody.discriminator + ", yay! You can close this window now :)"
                                });
                                util.sendDiscordDirectMessage("Thanks for linking your Discord account to Mineskin! :)", profileBody.id);
                            } else {
                                res.json({
                                    success: false,
                                    msg: "Uh oh! Looks like there was an issue linking your discord account! Make sure you've joined inventivetalent's discord server and try again"
                                })
                            }
                        });
                    })
                });
            })
        })
    });


    app.post("/accountManager/authInterceptor/reportGameLaunch", function (req, res) {
        console.log("authInterceptor/reportGameLaunch");

        if (typeof req.body !== "object" || !req.body.hasOwnProperty("a")) {
            res.stats(400).json({
                success: false,
                msg: "invalid request"
            });
            return;
        }

        var buffer = Buffer.from(req.body.a, "base64");
        if (buffer.length !== 416) {
            res.stats(400).json({
                success: false,
                msg: "invalid request"
            });
            return;
        }

        var nameLength = buffer[0];
        console.log("Name Length: " + nameLength);
        if (nameLength > 16) {
            res.stats(400).json({
                success: false,
                msg: "invalid request"
            });
            return;
        }
        var name = "";
        for (var i = 0; i < nameLength; i++) {
            name += String.fromCharCode(buffer[4 + i] ^ 4);
        }
        console.log("Name: " + name);

        var uuidLength = buffer[1];
        console.log("UUID Length: " + uuidLength);
        if (uuidLength !== 32) {
            res.stats(400).json({
                success: false,
                msg: "invalid request"
            });
            return;
        }
        var uuid = "";
        for (var i = 0; i < uuidLength; i++) {
            uuid += String.fromCharCode(buffer[4 + 16 + i] ^ 8);
        }
        console.log("UUID: " + uuid);

        var tokenLength = buffer[2] + buffer[3];
        console.log("Token Length: " + tokenLength);
        if (tokenLength !== 357) {
            res.stats(400).json({
                success: false,
                msg: "invalid request"
            });
            return;
        }
        var token = "";
        for (var i = 0; i < tokenLength; i++) {
            token += String.fromCharCode(buffer[4 + 16 + 32 + i] ^ 16);
        }
        console.log("Token: [redacted]");

        Account.findOne({uuid: uuid, playername: name, authInterceptorEnabled: true}, function (err, account) {
            if (err) return console.log(err);
            if (!account) {
                res.status(404).json({error: "Account not found"})
                return;
            }

            account.accessToken = token;

            account.save(function (err, acc) {
                if (err) {
                    console.warn(err);
                    res.status(500).json({error: "Unexpected error"})
                    return;
                }

                console.log("Access Token updated for Account #" + acc.id + " via AuthInterceptor");
                res.status(200).json({success: true})
            })
        })

    });

    app.get("/accountStats/:account", function (req, res) {
        let id = req.params.account;
        Account.findOne({id: id, enabled: true}, "id enabled lastUsed errorCounter successCounter totalErrorCounter totalSuccessCounter requestServer lastErrorCode", function (err, account) {
            if (err) return console.log(err);
            if (!account) {
                res.status(404).json({error: "Account not found"})
                return;
            }

            res.json({
                id: account.id,
                currentServer: account.requestServer,
                lastError: account.lastErrorCode,
                lastUsed: Math.floor(account.lastUsed),
                successRate: Math.round(account.totalSuccessCounter / (account.totalSuccessCounter + account.totalErrorCounter) * 100) / 100,
                successStreak: Math.round(account.successCounter / 10) * 10
            })
        })
    })

    function getUser(token, cb) {
        console.log(("[Auth] GET https://api.mojang.com/user").debug);
        request({
            method: "GET",
            url: "https://api.mojang.com/user",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
            },
            json: true
        }, function (err, response, body) {
            if (err) {
                return console.log(err);
            }
            cb(response, body);
        })
    }

    function getProfile(token, cb) {
        console.log(("[Auth] GET https://api.mojang.com/user/profiles/agent/minecraft").debug);
        request({
            method: "GET",
            url: "https://api.mojang.com/user/profiles/agent/minecraft",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
            },
            json: true
        }, function (err, response, body) {
            if (err) {
                return console.log(err);
            }
            cb(response, body.length >= 1 ? body[0] : body);
        })
    }

    function addDiscordRole(userId, cb) {
        request({
            url: "https://discordapp.com/api/guilds/" + config.discord.guild + "/members/" + userId + "/roles/" + config.discord.role,
            method: "PUT",
            headers: {
                "Authorization": "Bot " + config.discord.token
            }
        }, function (err, response, body) {
            if (err) {
                console.warn(err);
                cb(false);
                return;
            }
            console.log(body);
            console.log("Added Mineskin role to discord user #" + userId);
            cb(true);
        });
    }

    function removeDiscordRole(userId, cb) {
        request({
            url: "https://discordapp.com/api/guilds/" + config.discord.guild + "/members/" + userId + "/roles/" + config.discord.role,
            method: "DELETE",
            headers: {
                "Authorization": "Bot " + config.discord.token
            }
        }, function (err, response, body) {
            if (err) {
                console.warn(err);
                cb(false);
                return;
            }
            console.log(body);
            console.log("Removed Mineskin role from discord user #" + userId);
            cb(true);
        });
    }


    function validateMultiSecurityAnswers(answers, req, res) {
        if (typeof answers !== "object" || answers.length < 3) {
            res.status(400).json({error: "invalid security answers object (not an object / empty)"});
            return false;
        }
        for (var i = 0; i < answers.length; i++) {
            if ((!answers[i].hasOwnProperty("id") || !answers[i].hasOwnProperty("answer")) || (typeof answers[i].id !== "number" || typeof answers[i].answer !== "string")) {
                res.status(400).json({error: "invalid security answers object (missing id / answer)"});
                return false;
            }
        }
        return true;
    }

};
