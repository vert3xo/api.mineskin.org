var request = require("request");

module.exports = {};

var cache = {};

setInterval(function () {
    for (var id in cache) {
        if ((Date.now() / 1000) - cache[id].time > 60) {
            delete cache[id];
        }
    }
}, 60000);

module.exports.getSkinData = function (account, cb) {
    console.log(("[DataFetcher] Loading Skin data for " + (account.id ? "account #" + account.id + " ("+account.uuid+")"  : account.uuid)).info);
    console.log(account.uuid.debug)
    setTimeout(function () {
        if (cache.hasOwnProperty(account.uuid)) {
            console.warn("DATA FETCHER CACHE HIT! Current Size: " + Object.keys(cache).length);
            cb(null, cache[account.uuid]);
        }else {
            request("https://sessionserver.mojang.com/session/minecraft/profile/" + account.uuid + "?unsigned=false", function (err, response, body) {
                if (err) {
                    console.log(err);
                    return cb(err, null);
                }
                console.log(response.statusCode.toString().debug);
                console.log(body.debug)
                if (response.statusCode < 200 || response.statusCode > 230) {
                    return cb(response.statusCode, null);
                }
                if (!body) {
                    cb(null, null);
                    return;
                }
                var json = JSON.parse(body);
                var data = {
                    value: json.properties[0].value,
                    signature: json.properties[0].signature,
                    raw: json,
                    time: Date.now() / 1000
                };
                // if (!account.id) {// should be a user request
                    cache[account.uuid] = data;
                // }
                cb(null, data);
            });
        }
    }, 200);
};
