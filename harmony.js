/**
 *
 *      ioBroker Logitech Harmony Adapter
 *
 *      MIT License
 *
 */
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const { getHarmonyClient, HarmonyClient } = require(`@harmonyhub/client-ws`);
const HarmonyHubDiscover = require(`@harmonyhub/discover`).Explorer;
const utils = require(`@iobroker/adapter-core`);
const HarmonyWS = require(`harmonyhubws`);
const hubs = {};
let adapter;
let discover;
const FORBIDDEN_CHARS = /[\][*,;'"`<>\\? ]/g;
const fixId = (id) => id.replace(FORBIDDEN_CHARS, `_`);
let manualDiscoverHubs;
let subnet;
let discoverInterval;


function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: `harmony`
    });
    adapter = new utils.Adapter(options);

    adapter.on(`stateChange`, (id, state) => {
        if (!id || !state || state.ack) {
            return;
        }
        const hub = id.split(`.`)[2];
        if (!hubs[hub]) return;
        const semaphore = hubs[hub].semaphore;
        if (semaphore === undefined) {
            adapter.log.warn(`state changed in offline hub`);
            return;
        }
        if (semaphore.current > 0) {
            adapter.log.info(`hub busy, stateChange delayed: ${id} = ${state.val}`);
        }
        semaphore.take(() => {
            setBlocked(hub, true);
            processStateChange(hub, id, state, () => {
                if (semaphore.current === 1) {
                    setBlocked(hub, false);
                }
                semaphore.leave();
            });
        });
    });

    // callback has to be called under any circumstances
    adapter.on(`unload`, callback => {
        try {
            adapter.log.info(`[END] Terminating`);
            if (discover) {
                discover.stop();
            } // endIf
            discover = null;
            for (const hub in Object.keys(hubs)) {
                clientStop(hub);
            } // endFor
            callback();
        } catch (e) {
            callback();
        } // endTryCatch
    });

    adapter.on(`ready`, () => {
        main();
    });

    return adapter;
} // endStartAdapter

function processStateChange(hub, id, state, callback) {
    const tmp = id.split(`.`);
    let channel = ``;
    let name = ``;
    if (tmp.length === 5) {
        name = tmp.pop();
        channel = tmp.pop();
    } else {
        adapter.log.warn(`unknown state change`);
        return;
    }
    switch (channel) {
        case `activities`:
            switch (name) {
                case `currentStatus`:
                    switchActivity(hub, undefined, 0, callback);
                    break;
                case `currentActivity`:
                    adapter.log.warn(`change activities, not currentActivity`);
                    callback();
                    break;
                default:
                    switchActivity(hub, name, state.val, callback);
                    break;
            }
            break;
        default:
            adapter.log.debug(`sending command: ${channel}:${name}`);
            if (state.val) {
                let ms = parseInt(state.val);
                if (isNaN(ms) || ms < 100) {
                    ms = 100;
                }
                sendCommand(hub, id, ms, callback);
            } else {
                adapter.setState(id, {val: 0, ack: true});
                callback();
            }
            break;
    }
}

function sendCommand(hub, id, ms, callback) {
    adapter.getObject(id, function (err, obj) {
        if (err) {
            adapter.log.warn(`cannot send command, unknown state`);
            adapter.setState(id, {val: 0, ack: true});
            callback();
            return;
        }
        if (!hubs[hub].client || hubs[hub].client.status !== 3) {
            adapter.log.warn(`error sending command, client offline`);
            adapter.setState(id, {val: 0, ack: true});
            callback();
            return;
        }
        adapter.log.debug(`sending command: ${obj.common.name}`);

        if (ms <= 250) {
            hubs[hub].client.requestKeyPress(obj.native.action, 100);
            adapter.setState(id, {val: 0, ack: true});
            callback();
        } else {
            hubs[hub].client.requestKeyPress(obj.native.action, `hold`, ms);
            setTimeout(() => {
                adapter.setState(id, {val: 0, ack: true});
                callback();
            }, ms);
        }
    });
}

function switchActivity(hub, activityLabel, value, callback) {
    // TODO: requestActivityChange is no longer a fully working promise (it resolves after execution now instead
    //  of after hub has confirmed that the activity has been changed). So we should just block hub before
    //  calling switchActivity and unblock on receiving changed activity in listener maybe in setStatusFromActivityID
    if (!hubs[hub].client) {
        adapter.log.warn(`[ACTIVITY] Error changing activity, client offline`);
        callback();
        return;
    }
    //get current Activity
    value = parseInt(value);
    if (isNaN(value)) value = 1;
    if (value === 0) {
        adapter.log.debug(`[ACTIVITY] Turning activity off`);
        hubs[hub].client.requestActivityChange(`-1`).then(callback);
    } else if (hubs[hub].activities_reverse.hasOwnProperty(activityLabel)) {
        adapter.log.debug(`[ACTIVITY] Switching activity to: ${activityLabel}`);
        hubs[hub].client.requestActivityChange(hubs[hub].activities_reverse[activityLabel]).then(callback);
    } else {
        adapter.log.warn(`[ACTIVITY] Activity does not exists`);
        callback();
    }
}

function main() {
    manualDiscoverHubs = adapter.config.devices || [];
    subnet = adapter.config.subnet || `255.255.255.255`;
    discoverInterval = adapter.config.discoverInterval || 1000;
    adapter.subscribeStates(`*`);

    adapter.log.info(`trying to connect to first manual hub: ` + manualDiscoverHubs[0].ip);
    connectToHub(manualDiscoverHubs[0].ip);
    // adapter.log.debug(`[START] Subnet: ${subnet}, Discovery interval: ${discoverInterval}`);
    // discoverStart();
}

async function connectToHub(hubHost) {
    try {
        const options = undefined;
        // const harmonyClient = await getHarmonyClient(hubHost, options);
        // if (harmonyClient) adapter.log.info(`successfully connected to hub: ` + hubHost);
        
        return initHub(hubHost, () => {
            adapter.log.info(`successfully initialized hub: ` + hubHost);
            // adapter.log.debug(JSON.stringify(hub, null, 3));

            // const hubName = fixId(harmonyClient.friendlyName).replace(`.`, `_`);
            return connect(hubHost, hubHost);
        });
    } catch (error) {
        adapter.log.error(`could not connect to hub: ` + hubHost);
        adapter.log.error(error);
    }
}

// function discoverStart() {
//     if (discover) {
//         adapter.log.debug(`[DISCOVER] Discover already started`);
//         return;
//     } // endIf

//     adapter.getPort(61991, port => {
//         discover = new HarmonyHubDiscover(port, {address: subnet, port: 5224, interval: discoverInterval});
//         discover.on(HarmonyHubDiscover.Events.ONLINE, hub => {
//             // Triggered when a new hub was found
//             if (hub.friendlyName !== undefined) {
//                 let addHub = false;
//                 const hubName = fixId(hub.friendlyName).replace(`.`, `_`);

//                 if (manualDiscoverHubs.length) {
//                     for (const manualDiscoverHub of manualDiscoverHubs) {
//                         if (manualDiscoverHub.ip === hub.ip && !hubs[hubName]) {
//                             adapter.log.info(`[DISCOVER] Discovered ${hub.friendlyName} (${hub.ip}) and will try to connect`);
//                             addHub = true;
//                         } else if (!hubs[hubName]) {
//                             adapter.log.debug(`[DISCVOER] Discovered ${hub.friendlyName} (${hub.ip}) but won't try to connect, because \
//                             manual search is configured and hub's ip not listed`);
//                         }
//                     } // endFor
//                 } else if (!hubs[hubName]) {
//                     adapter.log.info(`[DISCOVER] Discovered ${hub.friendlyName} (${hub.ip}) and will try to connect`);
//                     addHub = true; // if no manual discovery --> add all hubs
//                 }

//                 if (addHub) {
//                     initHub(hubName, () => {
//                         // wait 2 seconds for hub before connecting
//                         adapter.log.info(`[CONNECT] Connecting to ${hub.friendlyName} (${hub.ip})`);
//                         connect(hubName, hub);
//                     });
//                 } // endIf
//             } // endIf
//         });

//         discover.on(`error`, err => {
//             adapter.log.warn(`[DISCOVER] Discover error: ${err.message}`);
//         });

//         discover.start();
//         adapter.log.info(`[DISCOVER] Searching for Harmony Hubs on ${subnet}`);
//     });
// } // endDiscoverStart

function initHub(hubName, callback) {
    hubs[hubName] = {
        client: null,
        connected: false,
        activities: {},
        activities_reverse: {},
        devices: {},
        devices_reverse: {},
        blocked: true,
        timestamp: null,
        statesExist: false,
        ioChannels: {},
        ioStates: {},
        isSync: false,
        semaphore: require(`semaphore`)(1)
    };

    adapter.getState(`${hubName}.hubConnected`, (err, state) => {
        if (err || !state) {
            adapter.log.debug(`hub not initialized`);
            callback();
        } else {
            adapter.getChannelsOf(hubName, (err, channels) => {
                if (err || !channels) {
                    adapter.log.debug(`hub not initialized correctly`);
                    callback();
                    return;
                }
                for (let i = 0; i < channels.length; i++) {
                    const channel = channels[i];
                    if (channel.common.name === `activities`) {
                        hubs[hubName].statesExist = true;
                        setBlocked(hubName, true);
                        setConnected(hubName, false);
                        hubs[hubName].hasActivities = true;
                        adapter.log.debug(`hub initialized`);
                        continue;
                    }
                    hubs[hubName].ioChannels[channel.common.name] = true;
                }
                adapter.getStates(`${hubName}.activities.*`, (err, states) => {
                    if (err || !states) {
                        adapter.log.debug(`no activities found`);
                        callback();
                        return;
                    }
                    for (const state in states) {
                        if (states.hasOwnProperty(state)) {
                            const tmp = state.split(`.`);
                            const name = tmp.pop();
                            if (name !== `currentStatus` && name !== `currentActivity`) {
                                hubs[hubName].ioStates[name] = true;
                            }
                        }
                    }
                    callback();
                });
            });
        }
    });
}

function clientStop(hub) {
    setConnected(hub, false);
    setBlocked(hub, false);
    if (hubs[hub] && hubs[hub].client !== null) {
        hubs[hub].client.close();
        hubs[hub].client = null;
    }
}

function connect(hubName, ip) {
    if (!hubs[hubName] ) {
        adapter.log.error(`could not connect to hub: ${hubName}`);    
        adapter.log.error(`hubs[hubName] is empty`); 
        return;
    }

    if (hubs[hubName].client !== null) {
        adapter.log.error(`could not connect to hub: ${hubName}`);    
        adapter.log.error(`hubs[hubName].client is already present`);
        return;
    }

    const client = new HarmonyWS(ip);
    hubs[hubName].client = client;
    adapter.log.info(`successfully added client to hubs list: ${hubName}`);

    client.on(`online`, () => {
        adapter.log.debug(`received online event from hub: ${hubName}`);
        setBlocked(hubName, true);
        setConnected(hubName, true);
        adapter.log.info(`[CONNECT] Connected to ${hubName}`);
        hubs[hubName].client.requestConfig();
    });

    client.on(`offline`, () => {
        adapter.log.debug(`received offline event from hub: ${hubName}`);
        if (hubs[hubName].connected)
            adapter.log.info(`[CONNECT] lost Connection to ${hubName}`);
        setConnected(hubName, false);
        setBlocked(hubName, false);
    });

    client.on(`config`, (config) => {
        adapter.log.debug(`received config event from hub: ${hubName}`);
        try {
            processConfig(hubName, config);
            hubs[hubName].client.requestState();
        } catch (e) {
            adapter.log.error(e);
        }
    });

    client.on(`state`, (activityId, activityStatus) => {
        adapter.log.debug(`received state event from hub: ${hubName}`);
        processDigest(hubName, activityId, activityStatus);
    });

    adapter.log.info(`successfully bound events for hub: ` + hubName);
}

function processConfig(hub, config) {
    if (hubs[hub].isSync) {
        setBlocked(hub, false);
        setConnected(hub, true);
        return;
    }
    /* create hub */
    adapter.log.debug(`[PROCESS] Creating activities and devices`);

    adapter.log.debug(`[PROCESS] Creating hub device`);
    adapter.setObject(hub, {
        type: `device`,
        common: {
            name: hub
        },
        native: `removed`
    });

    if (!hubs[hub].statesExist) {
        adapter.setObject(`${hub}.hubConnected`, {
            type: `state`,
            common: {
                name: `${hub}:hubConnected`,
                role: `indicator.hubConnected`,
                type: `boolean`,
                write: false,
                read: true
            },
            native: {}
        });
    }
    adapter.setState(`${hub}.hubConnected`, {val: true, ack: true});

    if (!hubs[hub].statesExist) {
        adapter.setObject(`${hub}.hubBlocked`, {
            type: `state`,
            common: {
                name: `${hub}:hubBlocked`,
                role: `indicator.hubBlocked`,
                type: `boolean`,
                write: false,
                read: true
            },
            native: {}
        });
    }
    adapter.setState(`${hub}.hubBlocked`, {val: true, ack: true});

    /* create activities */
    adapter.log.debug(`creating activities`);
    let channelName = `${hub}.activities`;
    //create channel for activities
    adapter.setObject(channelName, {
        type: `channel`,
        common: {
            name: `activities`,
            role: `media.activities`
        },
        native: {}
    });

    if (!hubs[hub].statesExist) {
        adapter.setObject(`${channelName}.currentActivity`, {
            type: `state`,
            common: {
                name: `activity:currentActivity`,
                role: `indicator.activity`,
                type: `string`,
                write: true,
                read: true
            },
            native: {}
        });
        adapter.setObject(`${channelName}.currentStatus`, {
            type: `state`,
            common: {
                name: `activity:currentStatus`,
                role: `indicator.status`,
                type: `number`,
                write: true,
                read: true,
                min: 0,
                max: 3
            },
            native: {}
        });
    }

    config.activity.forEach(activity => {
        const activityLabel = fixId(activity.label).replace(`.`, `_`);
        hubs[hub].activities[activity.id] = activityLabel;
        hubs[hub].activities_reverse[activityLabel] = activity.id;
        if (activity.id === `-1`) return;
        //create activities
        const activityChannelName = `${channelName}.${activityLabel}`;
        //create channel for activity
        delete activity.sequences;
        delete activity.controlGroup;
        delete activity.fixit;
        delete activity.rules;
        //create states for activity
        if (!hubs[hub].ioStates.hasOwnProperty(activityLabel)) {
            adapter.log.info(`[PROCESS] Added new activity: ${activityLabel}`);
            adapter.setObject(activityChannelName, {
                type: `state`,
                common: {
                    name: `activity:${activityLabel}`,
                    role: `switch`,
                    type: `number`,
                    write: true,
                    read: true,
                    min: 0,
                    max: 3
                },
                native: activity
            });
        }
        delete hubs[hub].ioStates[activityLabel];
    });

    /* create devices */
    adapter.log.debug(`[PROCESS] Creating devices`);
    channelName = hub;
    config.device.forEach(device => {
        const deviceLabel = fixId(device.label).replace(`.`, `_`);
        const deviceChannelName = `${channelName}.${deviceLabel}`;
        const controlGroup = device.controlGroup;
        hubs[hub].devices[device.id] = deviceLabel;
        hubs[hub].devices_reverse[deviceLabel] = device.id;
        delete device.controlGroup;
        //create channel for device
        if (!hubs[hub].ioChannels.hasOwnProperty(deviceLabel)) {
            adapter.log.info(`[PROCESS] Added new device: ${deviceLabel}`);
            adapter.setObject(deviceChannelName, {
                type: `channel`,
                common: {
                    name: deviceLabel,
                    role: `media.device`
                },
                native: device
            });
            controlGroup.forEach(controlGroup => {
                const groupName = controlGroup.name;
                controlGroup.function.forEach(command => {
                    command.controlGroup = groupName;
                    command.deviceId = device.id;
                    const commandName = fixId(command.name).replace(`.`, `_`);
                    //create command
                    adapter.setObject(`${deviceChannelName}.${commandName}`, {
                        type: `state`,
                        common: {
                            name: `${deviceLabel}:${commandName}`,
                            role: `button`,
                            type: `number`,
                            write: true,
                            read: true,
                            min: 0
                        },
                        native: command
                    });
                    adapter.setState(`${deviceChannelName}.${commandName}`, {val: `0`, ack: true});
                });
            });
        }
        delete hubs[hub].ioChannels[deviceLabel];
    });

    adapter.log.debug(`[PROCESS] Deleting activities`);
    Object.keys(hubs[hub].ioStates).forEach(activityLabel => {
        adapter.log.info(`[PROCESS] Removed old activity: ${activityLabel}`);
        adapter.deleteState(hub, `activities`, activityLabel);
    });

    adapter.log.debug(`[PROCESS] Deleting devices`);
    Object.keys(hubs[hub].ioChannels).forEach(deviceLabel => {
        adapter.log.info(`[PROCESS] Removed old device: ${deviceLabel}`);
        adapter.deleteChannel(hub, deviceLabel);
    });

    hubs[hub].statesExist = true;
    setBlocked(hub, false);
    setConnected(hub, true);
    hubs[hub].isSync = true;
    adapter.log.info(`[PROCESS] Synced hub config for ${hubObj.friendlyName} (${hubObj.ip})`);
}

function processDigest(hub, activityId, activityStatus) {
    //set hub activity to current activity label
    setCurrentActivity(hub, activityId);
    //Set hub status to current activity status
    setCurrentStatus(hub, activityStatus);

    if (activityId !== `-1`) { //if activityId is not powerOff
        //set activityId's status
        setStatusFromActivityID(hub, activityId, activityStatus);

        //if status is 'running' set all other activities to 'off'
        if (activityStatus === 2) {
            //only one activity can run at once, set all other activities to off
            for (const activity in hubs[hub].activities) {
                if (hubs[hub].activities.hasOwnProperty(activity) && activity !== activityId) {
                    setStatusFromActivityID(hub, activity, 0);
                }
            }
        }
    } else { //set all activities to 'off' since powerOff activity is active
        for (const oActivity in hubs[hub].activities) {
            if (hubs[hub].activities.hasOwnProperty(oActivity)) {
                setStatusFromActivityID(hub, oActivity, 0);
            }
        }
    }
}

function setCurrentActivity(hub, id) {
    if (!hubs[hub].activities.hasOwnProperty(id)) {
        adapter.log.debug(`[SETACTIVITY] Unknown activityId: ${id}`);
        return;
    }
    adapter.log.debug(`current activity: ${hubs[hub].activities[id]}`);
    adapter.setState(`${hub}.activities.currentActivity`, {val: hubs[hub].activities[id], ack: true});
}

function setCurrentStatus(hub, status) {
    if (hubs[hub].statesExist)
        adapter.setState(`${hub}.activities.currentStatus`, {val: status, ack: true});
}

function setStatusFromActivityID(hub, id, value) {
    if (id === `-1`) return;
    if (!hubs[hub].activities.hasOwnProperty(id)) {
        adapter.log.warn(`[SETSTATE] Unknown activityId: ${id}`);
        return;
    }
    const channelName = fixId( `${hub}.activities.${hubs[hub].activities[id]}`);
    adapter.setState(channelName, {val: value, ack: true});
}

function setBlocked(hub, bool) {
    if (hubs[hub] && hubs[hub].statesExist) {
        bool = Boolean(bool);
        adapter.setState(`${hub}.hubBlocked`, {val: bool, ack: true});
        hubs[hub].blocked = bool;
    }
}

function setConnected(hub, bool) {
    if (hubs[hub] && hubs[hub].statesExist) {
        bool = Boolean(bool);
        hubs[hub].connected = bool;
        adapter.setState(`${hub}.hubConnected`, {val: bool, ack: true});
    }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
