import { LEAGUES } from '../model/leagues';
import { MODEL_WEIGHT, modelHasSay } from '../model/parlays';
import type { GameData } from '../model/types';
import { blendText } from './parlays';

export function Method(props: { game: GameData }) {
  const g = props.game;
  const lg = LEAGUES[g.league];
  return (
    <div class="method card prose">
      <h2>How the simulator works</h2>
      <p>
        Each simulation plays the game one possession at a time, about {Math.round(lg.pace)} per team in {lg.label === 'NBA' ? 'an NBA' : 'a college'} game. On every trip, one
        of the five players on the floor ends the possession, chosen by usage rate. He turns it over, draws a shooting foul, or takes a shot from one of five zones: the
        restricted area, the rest of the paint, mid-range, the corners, or above the break. His make rate in that zone is adjusted for the defense's record against that
        zone, home court, and how stretched his lineup is for shot creation.
      </p>
      <h3>Where the numbers come from</h3>
      <ul>
        <li>
          <b>Player tendencies</b> come from each team's last {g.demo ? 'several' : 'ten'} completed games on ESPN. The box scores give minutes, usage, turnovers, free
          throws, rebounding, assists, steals, blocks and fouls. The play-by-play gives every shot's location and who assisted whom. Players new to a team use their season
          averages. Everything is shrunk toward league norms by sample size, so a hot week doesn't become a superstar.
        </li>
        <li>
          <b>Team defense</b> is the opponents' shooting by zone and turnover rate in those same games, shrunk heavily toward league average.
        </li>
        <li>
          <b>Pace</b> blends both teams' recent possessions per game.
        </li>
        <li>
          <b>Injuries</b> come from ESPN's injury report. Anyone listed as out starts on the bench; flip the switch to clear him.
        </li>
      </ul>
      <h3>What happens when someone sits</h3>
      <p>
        His minutes are redistributed to healthy teammates, with players at his position absorbing more and nobody passing {lg.playerMinCap + 6} minutes. Rotations follow those
        minute targets: starters open each half, players with early foul trouble sit, closers play the last five minutes of a close game, and benches empty in blowouts.
        Losing a high-usage creator hurts twice: his possessions go to less efficient teammates, and lineups without enough shot creation or passing shoot worse and turn it
        over more.
      </p>
      <h3>Inside a possession</h3>
      <ul>
        <li>Assists come from a passing network: each passer's share of assists to each teammate.</li>
        <li>
          Misses can be blocked, more often at the rim and with shot blockers on the floor. Offensive rebounds pit the two lineups' rebounding rates against each other,
          with diminishing returns.
        </li>
        <li>
          Fouls accumulate. The bonus is live, players in foul trouble defend more carefully, and {lg.foulOut} fouls end a night. The whistle slider scales every foul call
          and so shifts free throws, foul trouble and rotations.
        </li>
        <li>
          Late in close games, leaders milk the clock, trailing teams hurry and hunt threes, teams down one to three hold for the last shot, and trailing defenses foul on
          purpose: down four to nine inside {lg.intentionalFoulWindow} seconds, or down one to three once the leader could run out the clock.
        </li>
        <li>Big leads breed a little complacency and deficits a little urgency, which keeps the spread of results in line with real games.</li>
      </ul>
      <h3>Reading the results</h3>
      <p>
        Win chances carry sampling error of about ±1.4 points at 5,000 simulations. The typical game is a real simulation, the one whose margin, total and main
        scorers sit nearest the middle, so you can read its box score and play-by-play as a plausible version of tonight. Fixing the seed makes every number reproducible
        and shareable.
      </p>
      <h3>Suggested parlays</h3>
      <p>
        Parlays use only legs with a posted price: moneylines, spreads and totals. Legs from the same game are scored together from that game's simulations, so legs that tend to
        win together are priced that way. Legs from different games are treated as independent. Model chances are weighted against the market's no-vig odds by how much the
        model earned in backtests on last season's games, where the market alone did best on most bets. For {lg.label} games, {blendText(MODEL_WEIGHT[g.league])}
        {modelHasSay(g.league)
          ? '.'
          : ", so no weighted suggestion can beat the vig. The tab therefore opens on the simulation's own picks, ranked by its chances alone and labeled as such; their expected returns are likely overstated."}{' '}
        A switch on the tab moves between the two rankings. A suggestion needs positive expected value, a minimum hit chance and a capped price. Player props use the
        book's posted lines from ESPN and each player's line in every simulation, so a prop and the game result are scored together. Props have no backtest, so only the
        simulation-only ranking can pick them, and players projected under 15 minutes are left out. Simulating the slate fetches every game's props too; lines for
        games other than the open one are as of that game's simulation, cached for 30 minutes. During a game simulated from now, the book's in-game prop
        lines are read every two minutes and priced as each player's stats so far plus the simulated rest of the game. "All live games" does the same for
        every game in progress (2,000 sims each from its current state, refreshed every two minutes while open) and builds live parlays across them. The
        in-game book's live moneyline, spread and total join those parlays too, priced from the simulated final scores. These are suggestions from a model, not advice.
      </p>
      <h3>Limits</h3>
      <ul>
        <li>Individual defense beyond steals, blocks, rebounding and fouls isn't modeled; neither are matchups, rest, travel or motivation.</li>
        <li>Shot zones depend on ESPN's play text. College feeds rarely list shot distances, so college zones are coarser.</li>
        <li>Overtime comes up in about 3.7% of simulated NBA games against roughly 6% in real ones; the endgame is simpler than real coaching.</li>
        <li>The model knows nothing the box scores don't. Use it to reason about scenarios, not as a betting service.</li>
      </ul>
      <h3>Data for this game</h3>
      <ul>
        <li>
          {g.away.name}: {g.away.source || 'league priors'}
        </li>
        <li>
          {g.home.name}: {g.home.source || 'league priors'}
        </li>
        {g.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
