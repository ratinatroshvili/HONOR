import { useEffect } from "react";
import { actions, addr } from "../honor";
import { go, useHonor, useLoad } from "../state";
import { safeKey } from "./GroupView";

export function JoinView({ groupKey, code }: { groupKey: string; code: string }) {
  const { program, me, run, busy } = useHonor();
  const group = safeKey(groupKey);
  const { data, error } = useLoad(
    async (p) => {
      if (!group) return null;
      const [g, m] = await Promise.all([
        p.account.group.fetchNullable(group),
        p.account.membership.fetchNullable(addr.member(group, me!)),
      ]);
      return { g, member: !!m };
    },
    [groupKey],
  );
  const alreadyMember = !!data?.member;
  useEffect(() => {
    if (alreadyMember) go(`/g/${groupKey}`);
  }, [alreadyMember, groupKey]);

  if (!group || data === null || data?.g === null)
    return <p className="error pad center">This invite link doesn't point to a group. Ask for a new link.</p>;
  if (error) return <p className="error pad center">{error}</p>;
  if (!data) return <p className="muted pad center">Opening invite…</p>;
  if (data.member) return null;
  const g = data.g!;
  if (g.archived) return <p className="pad center">{g.name} has been removed and no longer takes new members.</p>;

  return (
    <section className="onboard panel">
      <span className="banner-flag big" aria-hidden>
        {g.name.trim().charAt(0).toUpperCase()}
      </span>
      <p className="eyebrow">You've been summoned</p>
      <h1 className="title">Join {g.name}</h1>
      <p className="lede">
        {g.memberCount} {g.memberCount === 1 ? "person is" : "people are"} already making calls here. Joining lets you
        predict, vote on results, review friends' proof and climb the group leaderboard.
      </p>
      <button
        className="btn btn-gold"
        disabled={busy}
        onClick={async () => {
          const ok = await run(`Joining ${g.name}…`, `You're in ${g.name}.`, () => actions.joinGroup(program, me!, group, code));
          if (ok) go(`/g/${groupKey}`);
        }}
      >
        Join {g.name}
      </button>
    </section>
  );
}
