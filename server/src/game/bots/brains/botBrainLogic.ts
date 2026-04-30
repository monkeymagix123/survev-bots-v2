import type { BotBrainType } from "../botBrain";
import type { BotDifficulty } from "../botDifficulty";
import type { Game } from "../../game";
import type { Player } from "../../objects/player";
import type { BotAimController } from "../systems/botAimController";
import type { BotLootScorer } from "../systems/botLootScorer";
import type { BotNavigationLite } from "../systems/botNavigationLite";
import type { BotPerception } from "../systems/botPerception";
import type { BotWeaponLogic } from "../systems/botWeaponLogic";
import type { BotCombatMemory } from "../botCombat";

export type BotBrainContext = {
    game: Game;
    player: Player;
    difficulty: BotDifficulty;
    timeNow: number;

    perception: BotPerception;
    navigation: BotNavigationLite;
    lootScorer: BotLootScorer;
    combat: BotCombatMemory;
    aim: BotAimController;
    weaponLogic: BotWeaponLogic;
};

export interface BotBrain {
    readonly type: BotBrainType;
    decide(ctx: BotBrainContext): void;
}
