import { util } from "../../utils/util";
import type { MapDef } from "../mapDefs";
import { MapId } from "../types/misc";
import { Main, type PartialMapDef } from "./baseDefs";

const mapDef: PartialMapDef = {
    mapId: MapId.Wave,
    isWave: true,
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
