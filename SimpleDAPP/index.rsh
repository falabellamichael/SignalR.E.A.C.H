'reach 0.1';

// A two-party agreement on a bounded numeric proposal.
// Alice sets a target and acceptable distance; Bob supplies a response.
// Both parties receive the same on-chain result.
export const main = Reach.App(() => {
  const Alice = Participant('Alice', {
    getProposedValue: Fun([], UInt),
    getTolerance: Fun([], UInt),
    seeOutcome: Fun([UInt, UInt, UInt, UInt, Bool], Null),
  });
  const Bob = Participant('Bob', {
    getResponse: Fun([], UInt),
    seeOutcome: Fun([UInt, UInt, UInt, UInt, Bool], Null),
  });
  init();

  // The bound keeps all sample values small and easy to inspect.
  const MAX_INPUT = 10000;

  Alice.only(() => {
    const proposed = declassify(interact.getProposedValue());
    const tolerance = declassify(interact.getTolerance());
    // Frontends validate these assumptions before sending a transaction.
    assume(proposed <= MAX_INPUT);
    assume(tolerance <= MAX_INPUT);
  });
  Alice.publish(proposed, tolerance);
  require(proposed <= MAX_INPUT);
  require(tolerance <= MAX_INPUT);
  commit();

  Bob.only(() => {
    const response = declassify(interact.getResponse());
    assume(response <= MAX_INPUT);
  });
  Bob.publish(response);
  require(response <= MAX_INPUT);

  // Subtract the smaller UInt from the larger one to avoid underflow.
  const difference = proposed >= response
    ? proposed - response
    : response - proposed;
  const accepted = difference <= tolerance;
  commit();

  each([Alice, Bob], () => {
    interact.seeOutcome(proposed, tolerance, response, difference, accepted);
  });
  exit();
});
