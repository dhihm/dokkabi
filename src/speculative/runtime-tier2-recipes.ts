import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { caseTestFile, matchingCaseRunner } from "../work/case-runners.ts";
import type { AuthorizedCaseRecipe } from "../work/case-authority.ts";
import {
	takeTier2Recipe,
	type AuthorizedCaseDispatch,
} from "../work/verify.ts";
import type { Tier2AuthorizedTest } from "./cow.ts";

export type Tier2RuntimeRecipe = Tier2AuthorizedTest & {
	readonly sourcePath: string;
	readonly sourceDigest: string;
};

export function consumeTier2RuntimeRecipes(
	sourceRoot: string,
	dispatch: AuthorizedCaseDispatch | undefined,
	recipeIds: readonly string[],
): readonly Tier2RuntimeRecipe[] {
	if (!dispatch) return [];
	const recipes = recipeIds.flatMap(
		(recipeId): readonly AuthorizedCaseRecipe[] => {
			const recipe = takeTier2Recipe(dispatch, recipeId);
			return recipe ? [recipe] : [];
		},
	);
	return Object.freeze(
		recipes.flatMap((recipe) => {
			const sourcePath = caseTestFile(recipe.args.command);
			const runner = matchingCaseRunner(recipe.args.command);
			if (
				recipe.tool !== "bash" ||
				!sourcePath ||
				runner?.id !== recipe.runnerId ||
				!sameSource(sourceRoot, sourcePath, recipe.sourceDigest)
			)
				return [];
			const selected: Tier2RuntimeRecipe = Object.freeze({
				recipeId: recipe.recipeId,
				args: recipe.args,
				resultPolicy: "warm_only",
				sourcePath,
				sourceDigest: recipe.sourceDigest,
			});
			return [selected];
		}),
	);
}

export function runtimeRecipeCurrent(
	sourceRoot: string,
	recipe: Tier2RuntimeRecipe,
): boolean {
	return sameSource(sourceRoot, recipe.sourcePath, recipe.sourceDigest);
}

function sameSource(
	root: string,
	sourcePath: string,
	expected: string,
): boolean {
	try {
		const canonicalRoot = realpathSync(resolve(root));
		const canonicalSource = realpathSync(resolve(canonicalRoot, sourcePath));
		const rel = relative(canonicalRoot, canonicalSource);
		if (
			rel === "" ||
			rel === ".." ||
			rel.startsWith(`..${sep}`) ||
			isAbsolute(rel)
		)
			return false;
		return (
			createHash("sha256")
				.update(readFileSync(canonicalSource))
				.digest("hex") === expected
		);
	} catch (error) {
		if (error instanceof Error) return false;
		return false;
	}
}
