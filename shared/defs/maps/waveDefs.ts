import { util } from "../../utils/util";
import type { MapDef } from "../mapDefs";
import { MapId } from "../types/misc";
import { Main, type PartialMapDef } from "./baseDefs";

const mapDef: PartialMapDef = {
    mapId: MapId.Wave,
    isWave: true,
    wave: {
        interWaveDelay: 3,
        waves: [
            {
                count: 4,
                brains: { practice: 2, realistic: 2 },
            },
            {
                count: 6,
                brains: { realistic: 4, competitive: 2 },
            },
            {
                count: 8,
                brains: { practice: 1, realistic: 4, competitive: 3 },
            },
            {
                count: 10,
                brains: { competitive: 10 },
            },
        ],
    },
    desc: {
        name: "Wave",
        icon: "img/gui/star.svg", // SHOULD CHANGE THIS
        buttonCss: "",
    },
    assets: {
        atlases: ["gradient", "loadout", "shared", "faction"],
    },
    gameMode: {
        maxPlayers: 100,
        factionMode: true,
        factions: 2,
    },
};

export const Wave = util.mergeDeep({}, Main, mapDef) as MapDef;
