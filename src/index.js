const TouchPortalAPI = require('touchportal-api');

// Create an instance of the Touch Portal Client
const TPClient = new TouchPortalAPI.Client();

// Define a pluginId, matches your entry.tp file
const pluginId = 'TPATEMPlugin';
const objectPath = require("object-path");
const fs = require('fs');
let macroList = null;
let runningMacro = null;
// keep track of macroPlayer states
let bIsWaiting = false;
let bIsRunning = false;
let bMacroLoop = false;
/*let rawdata = fs.readFileSync('settings.json');
let settings = JSON.parse(rawdata);
*/
let inTransition = false;
let inFTB = false

const { Atem } = require('atem-connection')
const myAtem = new Atem();

myAtem.on('info', console.log)
myAtem.on('error', console.error)
 
myAtem.on('connected', () => {
    console.log("Atem connected")
    macroList = BuildUsedMacros(myAtem.state);
    TPClient.choiceUpdate("availble_macros", macroList.map(function(item){return item.name;}))
    let states=[];

    states.push({id:"ATEM_RUNNING_MACRO", value: myAtem.state.macro.macroProperties[myAtem.state.macro.macroPlayer.macroIndex] || ""});
    bIsRunning = myAtem.state.macro.macroPlayer.isRunning;
    bIsWaiting = myAtem.state.macro.macroPlayer.isWaiting;
    states.push({id:"ATEM_MACRO_IS_RUNNING", value:`${bIsRunning && !bIsWaiting}`});
    
    bMacroLoop = myAtem.state.macro.macroPlayer.loop;
    states.push({id:"ATEM_MACRO_LOOP", value:`${bMacroLoop}`})
    TPClient.stateUpdateMany(states);  
})

function BuildUsedMacros(state){
    let usedMacros = [];
    for(let i = 0; i<100; i++){
        if(state.macro.macroProperties[i].isUsed){
            usedMacros.push({
                index:i,
                name: state.macro.macroProperties[i].name,
                description: state.macro.macroProperties[i].description
            })
        }
    }
    return usedMacros;
} 

myAtem.on('stateChanged', async (state, pathsToChange) => {
    let states = [];
    let stateObj = {}

    // console.log(state.video.mixEffects[0].transitionPosition.inTransition)

    // if (!state.video.mixEffects[0].transitionPosition.inTransition) {
    //     console.log('Transition is not in progress')
    //     TPClient.stateUpdate("ATEM_FTB", "false")
    // }

    for(programChange of pathsToChange){
        if(programChange.indexOf("programInput") > 0){
            //program change
            let newProgram = objectPath.get(state,programChange);
            stateObj.ATEM_SOURCE = newProgram.toString();
        }
        if(programChange.indexOf("macroProperties") > 0){
            macroList = BuildUsedMacros(state);
            TPClient.choiceUpdate("availble_macros", macroList.map(function(item){return item.name;}));
        }
        if(programChange.indexOf("macroPlayer") > 0){
            //macroPlayer change
            let macro = objectPath.get(state,programChange);
            if(macro.isRunning){
                // start macro
                runningMacro = macroList.find((item)=>item.index == macro.macroIndex);
                stateObj.ATEM_RUNNING_MACRO=runningMacro.name;
            }
            if(!macro.isRunning && !macro.isWaiting){
                //stop macro
                runningMacro = null;
                stateObj.ATEM_RUNNING_MACRO = "";
            }
        }
    }

    for(prop in stateObj){
        states.push({id:prop,value:stateObj[prop]});
    }

    if(bMacroLoop != myAtem.state.macro.macroPlayer.loop){
        bMacroLoop = myAtem.state.macro.macroPlayer.loop;
        states.push({id:"ATEM_MACRO_LOOP",value:`${bMacroLoop}`})
    }

    if(bIsRunning != myAtem.state.macro.macroPlayer.isRunning || bIsWaiting != myAtem.state.macro.macroPlayer.isWaiting){
        bIsRunning = myAtem.state.macro.macroPlayer.isRunning;
        bIsWaiting = myAtem.state.macro.macroPlayer.isWaiting;
        states.push({id:"ATEM_MACRO_IS_RUNNING",value:`${bIsRunning && !bIsWaiting}`})        
    }
    
    if(states.length == 0) return; // no real states we care about so don't send the updates of the atem
    
    if(states.length > 0) TPClient.stateUpdateMany(states);  
})

// Receive an Action Call from Touch Portal
TPClient.on("Action", async (data) => {
    if(data.actionId == "ATEM_SWITCH_SRC"){
        let newSource = parseInt(data.data[0].value);
        await myAtem.changeProgramInput(newSource).then(() => {
            TPClient.stateUpdate("ATEM_SOURCE", newSource);
        })
   }

   if(data.actionId == "ATEM_SWITCH_PVW"){
        let newPreview = parseInt(data.data[0].value);
        await myAtem.changePreviewInput(newPreview).then(() => {
            TPClient.stateUpdate("ATEM_PVW", newPreview);
        })
    }

    if (data.actionId == "ATEM_AUTO_TRANSITION") {
        await myAtem.autoTransition(0)
        TPClient.stateUpdate("ATEM_TRANSITION_STATE", "true");
        await waitForStateEnd("transition")
        const states = [
            { id: "ATEM_TRANSITION_STATE", value: "false" },
            { id: "ATEM_PVW", value: myAtem.state.video.mixEffects[0].previewInput }
        ]
        TPClient.stateUpdateMany(states)
    }

    if (data.actionId == "ATEM_CUT") {
        await myAtem.cut() 
        TPClient.stateUpdate("ATEM_PVW", myAtem.state.video.mixEffects[0].previewInput);
    }
    

    if (data.actionId == "ATEM_FTB") {
        await myAtem.fadeToBlack()
        TPClient.stateUpdate("ATEM_FTB", "true");
        await waitForStateEnd("FTB");
        TPClient.stateUpdate("ATEM_FTB", "false")
    }
    

   if(data.actionId == "ATEM_RUN_MACRO"){
        runningMacro = macroList.find((item)=>item.name == data.data[0].value);    
        if(!runningMacro){
            console.log(`Macro ${data.data[0].value} not found!`);
            return;
        }
        await myAtem.macroRun(runningMacro.index).then(() => {
            // Fired once the atem has acknowledged the command
            // Note: the state likely hasnt updated yet, but will follow shortly
            console.log(`Started running macro ${runningMacro.name}`);
            // Once your action is done, send a State Update back to Touch Portal
            let states=[
                {id: "ATEM_RUNNING_MACRO", value: runningMacro.name},
                {id:"ATEM_MACRO_IS_RUNNING", value: `${!myAtem.state.macro.macroPlayer.isWaiting}`}
            ];
            TPClient.stateUpdateMany(states);
                
        })
    }

    if(data.actionId == "ATEM_PAUSE_MACRO"){
        console.log("Received pause macro...")
        if(!runningMacro){
            console.log("No Running macro. Doing nothing...");
            return;
        }
        let func = null;
        if(myAtem.state.macro.macroPlayer.isRunning){
            console.log("Pausing macro...")
            await myAtem.macroStop().then(()=>{
                bIsRunning = myAtem.state.macro.macroPlayer.isRunning;
                bIsWaiting = myAtem.state.macro.macroPlayer.isWaiting;
                let states=[
                    {id:"ATEM_MACRO_IS_RUNNING", value: `${bIsRunning && !bIsWaiting}`}
                ];
                TPClient.stateUpdateMany(states);
            });
        }
        else{
            console.log("Resuming macro...")
            await myAtem.macroContinue().then(()=>{
                let states=[
                    {id: "ATEM_RUNNING_MACRO", value: runningMacro.name},
                    {id:"ATEM_MACRO_IS_RUNNING", value: `${myAtem.state.macro.macroPlayer.isRunning}`}
                ];
                TPClient.stateUpdateMany(states);
            })
        }
    }  

    if(data.actionId == "ATEM_TOGGLE_MACRO_LOOP"){
        console.log("Recieved set macro loop...")
        await myAtem.macroSetLoop(!myAtem.state.macro.macroPlayer.loop).then(()=>{
            let states=[
                {id:"ATEM_MACRO_LOOP", value: `${myAtem.state.macro.macroPlayer.loop}`}
            ];
            TPClient.stateUpdateMany(states);
        })
    }     
});

TPClient.on("ListChange",(data) => {
    // An Action's List dropdown changed, handle it here
    /*
        {
            "type":"listChange",
            "pluginId":"id of the plugin",
            "actionId":"id of the action",
            "listId":"id of the list being used in the inline action",
            "instanceId":"id of the instance",
            "value":"newValue",
        }
    */

   

   // Now send choiceUpdateSpecific based on listChange value
   //TPClient.choiceUpdateSpecific("<state id>","value",data.instanceId)

});

// After join to Touch Portal, it sends an info message
// handle it here
TPClient.on("Info", async (data) => {
    //console.log(data);
    return;
    //Do something with the Info message here
    /*
        {
            "type":"info",
            "sdkVersion":"(SDK version code)"
            "tpVersionString":"(Version of Touch Portal in string format)"
            "tpVersionCode":"(Version of Touch Portal in code format)"
            "pluginVersion":"(Your plug-in version)"
        }
    */

    // Read some data about your program or interface, and update the choice list in Touch Portal
        // find AtemIP and connect atem

    let atem_found = false;

    for(i=0;i <data.settings.length; i++){

        for(const prop in data.settings[i]){

            if(prop == "AtemIP"){
                console.log("Connectiong to atem on "+ data.settings[i][prop] + "...");
                await myAtem.connect(data.settings[i][prop]);

                atem_found = true;

                break;

            }

        }

        if(atem_found) break;

    }
    //TPClient.choiceUpdate("<state id>",["choice1","choice2"]);

    // Dynamic State additions - for use when you want control over what states are available in TouchPortal
    //TPClient.createState("<new state id>","Description","Default Value");

});

TPClient.on("Settings", async (data) => {

    //Do something with the Settings message here
    // Note: this can be called any time settings are modified or saved in the TouchPortal Settings window.
    /* 
      [{"Setting 1":"Value 1"},{"Setting 2":"Value 2"},...,{"Setting N":"Value N"}]
    */
   //console.log(data);
    console.log("Received new settings...");
    // find AtemIP and connect atem

    let atem_found = false;

    for(i=0;i <data.length; i++){

        for(const prop in data[i]){

            if(prop == "AtemIP"){
                console.log("Connectiong to atem on "+ data[i][prop] + "...");
                await myAtem.connect(data[i][prop]);

                atem_found = true;

                break;

            }

        }

        if(atem_found) break;

    }
});

TPClient.on("Update", (curVersion, newVersion) => {
    console.log(`current:${curVersion}, new:${newVersion}`)
  });

//Connects and Pairs to Touch Portal via Sockete
TPClient.connect({ pluginId });

function waitForStateEnd(stateName) {
    return new Promise((resolve) => {
        const intervalId = setInterval(() => {
        switch (stateName) {
            case 'transition':
            if (!myAtem.state.video.mixEffects[0].transitionPosition.inTransition) {
                clearInterval(intervalId);
                resolve();
            }
            break;
            case 'FTB':
            if (!myAtem.state.video.mixEffects[0].fadeToBlack.inTransition) {
                clearInterval(intervalId);
                resolve();
            }
            break;
            // Add more cases for other states as needed
            default:
            throw new Error(`Unsupported state: ${stateName}`);
        }
        }, 100); // check every 100ms
    });
}