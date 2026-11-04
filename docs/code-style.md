# The Beautiful Code Manifesto

_A TypeScript guide to code that reads like intent_

---

## 0. The Premise

Code is read far more often than it is written. Every line is a message to the next person, who may be you six
months from now, tired, at 2am, during an incident.

**Beautiful code says what it means. It does not make the reader work out what it means.**

---

## 1. Show Intent, Hide Mechanics

A reader should understand _what_ happens before they need to know _how_. Raise the abstraction level until the
code reads like the requirement.

```ts
// ❌ Mechanics first. The reader has to work out the purpose.
const result = [];
for (let i = 0; i < users.length; i++) {
  if (users[i].lastLogin > Date.now() - 30 * 24 * 60 * 60 * 1000 && !users[i].banned) {
    result.push(users[i].email);
  }
}

// ✅ Intent first. The mechanics live one level down, behind names.
const emailsOfActiveUsers = users.filter(isRecentlyActive).filter(isInGoodStanding).map(toEmail);
```

The top level of any function should read like prose. If you have to squint, add a name.

---

## 2. Types Are Documentation That Can't Lie

Comments rot. Types are checked by the compiler on every build. **If you can say it in a type, don't say it in a
comment.**

```ts
// ❌ A promise the compiler can't keep.
/* always positive */
let index: number;

/* ISO-8601 string, UTC */
let createdAt: string;

/* user id, not order id! */
function cancel(id: string) {}
```

```ts
// ✅ A contract the compiler enforces.
let index: PositiveInteger;
let createdAt: UtcTimestamp;
function cancel(orderId: OrderId) {}
```

### Branded types: cheap and powerful

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

type PositiveInteger = Brand<number, 'PositiveInteger'>;
type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;
type EmailAddress = Brand<string, 'EmailAddress'>;
```

Brands are created only at the edges, through _smart constructors_ that validate once:

```ts
const toPositiveInteger = (value: number): PositiveInteger | undefined =>
  Number.isInteger(value) && value > 0 ? (value as PositiveInteger) : undefined;
```

After that, the rest of the codebase **never re-checks** the value. The type carries the proof.

```ts
cancelOrder(userId); // ✅ Compile error: UserId is not assignable to OrderId
```

### Make illegal states unrepresentable

```ts
// ❌ Four booleans and optionals allow 16+ combinations. Most are nonsense.
interface Request {
  isLoading: boolean;
  isError: boolean;
  data?: User;
  error?: Error;
}

// ✅ Exactly the states that can actually happen.
type Request =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User }
  | { status: 'failure'; error: Error };
```

If the state can't be built, you never write the bug that handles it wrong.

---

## 3. Pure Functions by Default

A pure function's output depends only on its input, and it changes nothing outside itself. It is the easiest
unit of code to read, test, reuse and trust.

```ts
// ✅ Pure. Read the signature and you know the whole story.
const applyDiscount = (price: Money, discount: Percentage): Money => multiply(price, 1 - discount / 100);
```

```ts
// ❌ Impure. Hidden inputs, hidden outputs.
function applyDiscount(cart: Cart) {
  cart.total = cart.total * (1 - config.discount / 100);
  analytics.track('discount_applied');
}
```

### Functional core, imperative shell

Side effects are needed: I/O, network, time, randomness. Push them to the **edges** and keep the middle pure.

```ts
// Shell: impure, thin, boring
async function handleCheckout(request: CheckoutRequest): Promise<Response> {
  const cart = await cartRepository.find(request.cartId);
  const now = clock.now();
  const outcome = checkout(cart, now); // ← pure core
  await cartRepository.save(outcome.cart);
  return toResponse(outcome);
}

// Core: pure, rich, where the real logic lives
const checkout = (cart: Cart, now: UtcTimestamp): CheckoutOutcome => {
  /* ... */
};
```

Note that `now` is passed **in**. A function that calls `Date.now()` internally is a function you can't test.

### Prefer immutability

```ts
// ❌
user.roles.push('admin');

// ✅
const promoted: User = { ...user, roles: [...user.roles, 'admin'] };
```

Use `readonly` liberally. Mark it at the type level so the compiler guards it:

```ts
interface User {
  readonly id: UserId;
  readonly roles: ReadonlyArray<Role>;
}
```

---

## 4. Interfaces Over Classes. Composition Over Inheritance.

OOP is a tool, not a worldview. Most code is **data plus transformations**, and in TypeScript that means plain
objects, types and functions.

```ts
// ❌ Ceremony. A class used as a namespace with state glued on.
class PriceCalculator {
  private taxRate: number;
  constructor(taxRate: number) {
    this.taxRate = taxRate;
  }
  calculate(items: Item[]): number {
    /* ... */
  }
}
new PriceCalculator(0.2).calculate(items);

// ✅ Data in, data out.
const totalWithTax = (items: ReadonlyArray<Item>, taxRate: TaxRate): Money => {
  /* ... */
};
```

### Depend on shapes, not implementations

```ts
interface Clock {
  now(): UtcTimestamp;
}
interface UserStore {
  findById(id: UserId): Promise<User | undefined>;
}
interface Notifier {
  send(to: EmailAddress, message: Message): Promise<void>;
}
```

Any object with the right shape works, whether it's a real database, an in-memory map, or a test stub. No
`extends`, no mocking framework.

```ts
const testClock: Clock = { now: () => fixedTime };
```

### When a class _is_ fine

- It wraps a resource with a real lifecycle (a connection pool, a file handle).
- A framework requires it.
- It holds state that must be encapsulated and mutated, and you have accepted that cost.

Even then, **expose it through an interface**, and never build inheritance hierarchies more than one level deep.
If you reach for `abstract class`, try a function that takes another function first.

---

## 5. Names Are the Interface to Your Mind

A name is the smallest unit of documentation. It should answer _what is this, and why does it exist?_

### Abbreviations are a smell

```ts
// ❌
const usrCnt = getUsrs().length;
const cfg = loadCfg();
function procReq(r: Req, ctx: Ctx) {}
const tmp = calc(a, b);

// ✅
const userCount = getUsers().length;
const config = loadConfig();
function processRequest(request: HttpRequest, context: RequestContext) {}
const monthlyRevenue = calculateRevenue(orders, month);
```

Keystrokes are free. Confusion is expensive. Accepted exceptions are universal idioms with tiny scope, such as
`i` in a three-line loop, `x`/`y` for coordinates, `id`, `url`, `html`. Even then, ask whether `index` or `row`
would read better.

### Name by role, not by type

```ts
// ❌
const stringList: string[] = ...;
const userObj = ...;
const data = await fetch(...);

// ✅
const pendingInvitations: EmailAddress[] = ...;
const currentUser = ...;
const invoice = await fetchInvoice(...);
```

### Booleans ask questions

```ts
isExpired, hasPermission, canRetry, shouldNotify; // ✅
expired, permission, retry, flag; // ❌
```

### Functions are verbs, values are nouns

```ts
const total = calculateTotal(items); // ✅
const calculateTotal = total(items); // ❌ the names are swapped
```

---

## 6. Functions Do One Thing

If you need "and" to describe a function, it is two functions.

```ts
// ❌ validateAndSaveAndNotify
async function registerUser(input: unknown) {
  // 80 lines: parse, validate, hash, insert, email, log
}

// ✅ The body is the table of contents.
async function registerUser(input: unknown): Promise<RegistrationResult> {
  const form = parseRegistrationForm(input);
  if (!form.ok) return form;

  const user = createUser(form.value, clock.now());
  await userStore.save(user);
  await notifier.send(user.email, welcomeMessage(user));

  return success(user);
}
```

### Avoid boolean parameters

```ts
// ❌ What does `true` mean?
render(document, true, false);

// ✅
render(document, { includeHeader: true, compressImages: false });
// or, better: two functions
renderWithHeader(document);
```

---

## 7. Errors Are Values

Exceptions are invisible in the type signature. A caller of `parse(input): Config` has no idea it can blow up.

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

type ConfigError = { kind: 'missing-field'; field: string } | { kind: 'invalid-port'; value: number };

const parseConfig = (raw: unknown): Result<Config, ConfigError> => {
  /* ... */
};
```

Now failure is part of the contract, and the compiler makes callers handle it.

Keep `throw` for **truly exceptional** conditions: programmer errors and broken invariants, things that should
crash.

### Exhaustiveness: let the compiler find what you forgot

```ts
const describe = (error: ConfigError): string => {
  switch (error.kind) {
    case 'missing-field':
      return `Missing required field: ${error.field}`;
    case 'invalid-port':
      return `Port ${error.value} is out of range`;
    default:
      return assertNever(error); // new variant = compile error here
  }
};

const assertNever = (value: never): never => {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
};
```

---

## 8. Flat Is Better Than Nested

Every level of indentation is a thing the reader must hold in their head.

```ts
// ❌ The arrow of doom
function ship(order: Order) {
  if (order) {
    if (order.isPaid) {
      if (order.items.length > 0) {
        if (warehouse.hasStock(order)) {
          return dispatch(order);
        }
      }
    }
  }
}

// ✅ Guard clauses. The happy path reads straight down.
function ship(order: PaidOrder): ShipResult {
  if (isEmpty(order.items)) return failure('empty-order');
  if (!warehouse.hasStock(order)) return failure('out-of-stock');

  return dispatch(order);
}
```

Note that `PaidOrder` removed a whole check. **Types remove branches.**

---

## 9. Parse, Don't Validate

Validation returns `boolean` and then forgets what it learned. Parsing returns a _better type_ and keeps it.

```ts
// ❌ Validated, but the type still says "any string". Every caller checks again.
if (isValidEmail(input)) sendTo(input);

// ✅ Parsed once at the boundary. Trusted forever after.
const email = parseEmail(input); // EmailAddress | undefined
if (email) sendTo(email); // sendTo only accepts EmailAddress
```

Untrusted data (`unknown`, JSON, user input, env vars) enters through a parser and comes out as a domain type.
**Nothing downstream sees raw input.**

---

## 10. Comments Explain _Why_, Never _What_

If a comment explains _what_ the code does, the code isn't clear enough. Rename, extract, or retype.

```ts
// ❌ Narrates the code
// loop through users and check if active
for (const user of users) { if (user.active) ... }

// ✅ Explains a decision the code can't express
// Stripe retries webhooks for up to 3 days, so we dedupe on event ID
// rather than timestamp to stay idempotent across retries.
const alreadyProcessed = await processedEvents.has(event.id);
```

Good comments capture **context, trade-offs, links to incidents, and non-obvious constraints**: things that live
outside the code.

---

## 11. No Magic, No Cleverness

```ts
// ❌
if (status === 3) { ... }
setTimeout(retry, 86400000);
const x = ~~(n / 2);
const has = !!~list.indexOf(item);

// ✅
if (status === OrderStatus.Shipped) { ... }
setTimeout(retry, ONE_DAY_IN_MS);
const half = Math.floor(n / 2);
const hasItem = list.includes(item);
```

Clever code impresses once and costs every time it's read. **Boring is a feature.**

---

## 12. Let the Compiler Work for You

```jsonc
// tsconfig.json: the floor, not the ceiling
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true
}
```

- `any` is a hole in the boat. Use `unknown` and parse it.
- `as` is a promise to the compiler. Every one should be justified, ideally only inside smart constructors.
- `!` (non-null assertion) is `as` in disguise. Treat it as a smell.
- Prefer `satisfies` over annotations when you want checking without widening.

```ts
const routes = {
  home: '/',
  profile: '/users/:id',
} satisfies Record<string, RoutePath>;
// keeps literal types AND checks the shape
```

---

## 13. Organize by Meaning, Not by Kind

```
❌ by technical layer          ✅ by domain
src/                           src/
  controllers/                   billing/
  services/                        invoice.ts
  models/                          payment.ts
  utils/                           billing.test.ts
  helpers/                       accounts/
                                   user.ts
                                   registration.ts
```

Things that change together live together. `utils/` and `helpers/` are where good names go to die.

---

## 14. Tests Are Executable Specifications

A test suite should read like the requirements document the team never wrote. **If the test names don't explain
the feature, the tests aren't finished.**

### Name tests after behaviour, not methods

```ts
// ❌ Describes the code
describe('OrderService', () => {
  it('test calculateTotal', () => {});
  it('calculateTotal 2', () => {});
  it('should work', () => {});
});

// ✅ Describes the rules
describe('order total', () => {
  it('sums item prices multiplied by quantity', () => {});
  it('applies percentage discounts before tax', () => {});
  it('never goes below zero, even with stacked discounts', () => {});
  it('rejects orders containing discontinued items', () => {});
});
```

Read only the `it(...)` lines out loud. A product manager should nod along.

### Test behaviour, not implementation

```ts
// ❌ Coupled to internals. Breaks on every refactor and catches no bugs.
assert.equal(cacheSetCalls.length, 1);
assert.deepEqual(taxSpy.calls[0], [0.2]);

// ✅ Coupled to the contract. Survives any refactor that keeps behaviour.
assert.deepEqual(totalWithTax(cart, standardRate), money(120));
```

A test that breaks when behaviour is unchanged is a false alarm. Teams learn to ignore those.

### Arrange, Act, Assert: visibly

```ts
it('grants a loyalty discount after the fifth order', () => {
  const customer = aCustomer({ completedOrders: 5 });
  const cart = aCart({ subtotal: money(100) });

  const total = checkoutTotal(customer, cart);

  assert.deepEqual(total, money(90));
});
```

Three blocks separated by blank lines, and one reason to fail.

### Builders over fixtures

```ts
// ❌ 40-line object literal copied into every test; the relevant field is buried
const user = { id: "u1", name: "A", email: "a@b.c", roles: [], createdAt: ..., /* ... */ };

// ✅ Defaults for everything; the test states only what matters to it
const aUser = (overrides: Partial<User> = {}): User => ({
  id: "user-1" as UserId,
  email: "ada@example.com" as EmailAddress,
  roles: [],
  createdAt: fixedTime,
  ...overrides,
});

const admin = aUser({ roles: ["admin"] });   // the whole point of the test, in one line
```

### Pure functions make tests trivial

This is §3's payoff. A pure function needs no mocks, setup, teardown or clock tricks:

```ts
const cases = [
  { price: money(100), discount: percent(10), expected: money(90) },
  { price: money(100), discount: percent(0), expected: money(100) },
  { price: money(100), discount: percent(100), expected: money(0) },
];

for (const { price, discount, expected } of cases) {
  it(`applyDiscount(${price}, ${discount}) = ${expected}`, () => {
    assert.deepEqual(applyDiscount(price, discount), expected);
  });
}
```

If a test needs five mocks, the problem is in the code under test, not the test. Move the logic into the pure
core.

### Fakes over mocks

Interfaces (§4) let you write tiny in-memory implementations that _behave_, instead of mocks that only _record_:

```ts
const inMemoryUserStore = (): UserStore => {
  const users = new Map<UserId, User>();
  return {
    findById: async (id) => users.get(id),
    save: async (user) => {
      users.set(user.id, user);
    },
  };
};
```

---

## 15. Async Code Should Read Like Sync Code

Async control flow is where intent gets lost fastest. Make the order of events obvious.

### `async`/`await` over promise chains

```ts
// ❌
function loadDashboard(userId: UserId) {
  return fetchUser(userId).then((user) =>
    fetchTeam(user.teamId).then((team) => fetchProjects(team.id).then((projects) => ({ user, team, projects }))),
  );
}

// ✅
async function loadDashboard(userId: UserId): Promise<Dashboard> {
  const user = await fetchUser(userId);
  const team = await fetchTeam(user.teamId);
  const projects = await fetchProjects(team.id);
  return { user, team, projects };
}
```

### Parallel when independent, and say so

```ts
// ❌ Accidentally sequential: three round-trips that could have been one
const profile = await fetchProfile(userId);
const notifications = await fetchNotifications(userId);
const settings = await fetchSettings(userId);

// ✅ The structure shows they are independent
const [profile, notifications, settings] = await Promise.all([
  fetchProfile(userId),
  fetchNotifications(userId),
  fetchSettings(userId),
]);
```

Use `Promise.allSettled` when partial failure is acceptable, and handle each outcome explicitly.

### No `await` in loops by accident

```ts
// ❌ N sequential requests, hidden in plain sight
for (const id of invoiceIds) {
  await sendReminder(id);
}

// ✅ Concurrent, and intentional
await Promise.all(invoiceIds.map(sendReminder));

// ✅ Or sequential, and *intentional*, so explain why
// Payment provider rate-limits to 1 req/s per merchant.
for (const id of invoiceIds) {
  await sendReminder(id);
}
```

For large collections, bound the concurrency with a small helper (`mapWithConcurrency(items, 5, fn)`). Unbounded
`Promise.all` over 10,000 items is an outage.

### No floating promises

```ts
// ❌ Errors vanish; ordering is undefined
saveAuditLog(event);

// ✅ Awaited
await saveAuditLog(event);

// ✅ Or explicitly detached, with a name that admits it
void fireAndForget(saveAuditLog(event), logger);
```

Every promise is awaited, returned, or handed to something that owns its errors.

### Cancellation and timeouts are parameters

```ts
// ❌ A magic timeout buried inside; impossible to cancel from outside
async function fetchReport(id: ReportId) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
}

// ✅ The caller decides
async function fetchReport(id: ReportId, signal: AbortSignal): Promise<Report> {
  const response = await fetch(reportUrl(id), { signal });
  return parseReport(await response.json());
}

await fetchReport(id, AbortSignal.timeout(REPORT_TIMEOUT_MS));
```

Long-running work that can't be cancelled is a resource leak waiting to happen.

### Async is an effect, so keep it at the edges

An `async` function is impure by definition. If async keeps spreading through your core logic, the I/O is too
deep. Fetch first, then compute:

```ts
const [order, rates] = await Promise.all([orders.find(id), taxRates.current()]);
const invoice = buildInvoice(order, rates); // pure, sync, trivially testable
await invoices.save(invoice);
```

---

## 16. A Module's Exports Are Its Interface

Everything you `export` is a promise to every caller. **Export the minimum needed, and design that minimum with
care.**

### Small public surface

```ts
// billing/invoice.ts

// ✅ Public: what callers need
export type { Invoice, InvoiceId };
export { buildInvoice, parseInvoiceId };

// ✅ Private: free to change tomorrow
const roundToCents = (amount: number): Money => {
  /* ... */
};
const lineItemTotal = (item: LineItem): Money => {
  /* ... */
};
```

An unexported function can be renamed, rewritten or deleted without searching the whole repo. That freedom keeps
code easy to change.

### One entry point per domain module

```
billing/
  index.ts          ← the public API: the only file others import from
  invoice.ts
  payment.ts
  tax-rules.ts      ← internal
```

```ts
// billing/index.ts
export { buildInvoice, type Invoice } from './invoice.ts';
export { capturePayment, type PaymentResult } from './payment.ts';
// tax-rules is deliberately absent
```

```ts
// ❌ Reaching into another module's internals
import { vatRateFor } from '../billing/tax-rules.ts';

// ✅ Going through the front door
import { buildInvoice } from '../billing/index.ts';
```

### Barrels at boundaries only

An `index.ts` at a **domain boundary** is an API. An `index.ts` in **every folder**, re-exporting everything, is
a liability. It hides circular dependencies, slows tooling and defeats tree-shaking. Use barrels to draw lines,
not to save keystrokes.

### Don't leak internal types

```ts
// ❌ The internal DB row shape is now part of your public contract
export function getUser(id: UserId): Promise<UserRow> {}

// ✅ Map at the boundary; the internal shape can evolve freely
export function getUser(id: UserId): Promise<User> {}
```

### No circular dependencies

If `billing` imports `accounts` and `accounts` imports `billing`, they are one module pretending to be two.
Either merge them or extract what they share into a third module that both depend on. Dependencies should form a
tree, not a web.

---

## 17. Types Should Clarify, Not Show Off

§2 says to put intent into types. This section is the brake. **A type that takes longer to understand than the
code it describes has failed.**

### Clever types are clever code

```ts
// ❌ Impressive. Unreadable. Unmaintainable.
type DeepPartialExcept<T, K extends PropertyKey> = {
  [P in keyof T as P extends K ? never : P]?: T[P] extends object ? DeepPartialExcept<T[P], K> : T[P];
} & { [P in keyof T as P extends K ? P : never]-?: T[P] };

// ✅ Boring. Obvious. Probably all you needed.
interface UserUpdate {
  readonly id: UserId;
  readonly name?: string;
  readonly email?: EmailAddress;
}
```

Type-level programming has a place: libraries, ORMs, routers. In application code, write the type out by hand.
Duplication in types costs far less than a type nobody dares to touch.

### Generics must earn their place

```ts
// ❌ A generic used once is just a confusing `unknown`
function logValue<T>(value: T): void {
  console.log(value);
}

// ✅
function logValue(value: unknown): void {
  console.log(value);
}
```

```ts
// ✅ Earned: T links the input to the output
function first<T>(items: ReadonlyArray<T>): T | undefined {
  return items[0];
}
```

**The rule:** a type parameter should appear at least twice, linking two positions. If it appears once, remove
it.

### Name type parameters when there's more than one

```ts
// ❌
function mapResult<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {}

// ✅
function mapResult<Value, Mapped, Failure>(
  result: Result<Value, Failure>,
  transform: (value: Value) => Mapped,
): Result<Mapped, Failure> {}
```

§5 applies to types too. `T` is fine alone. `T, U, V, E, K` is an abbreviation soup.

### Let inference work, and annotate at boundaries

```ts
// ❌ Noise
const count: number = items.length;
const names: string[] = users.map((user: User): string => user.name);

// ✅ Annotate exported signatures and return types; infer locals
export function activeUserNames(users: ReadonlyArray<User>): string[] {
  const active = users.filter(isActive);
  return active.map((user) => user.name);
}
```

Explicit return types on exported functions are documentation, and they stop accidental changes to the contract.
Local variables rarely need them.

---

## 18. Small Functions, Few Parameters

### Size: one screen, one level of abstraction

There's no magic line count, but if a function doesn't fit on a screen, it almost certainly does more than one
thing. The stronger test is **one level of abstraction**: don't mix "what the business does" with "how bytes
move" in the same body.

```ts
// ❌ High-level intent and low-level detail interleaved
async function onboardCustomer(input: unknown) {
  const form = parseOnboardingForm(input);
  const normalized = form.email.trim().toLowerCase().replace(/\+.*@/, '@');
  const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [normalized]);
  if (existing.rowCount > 0) throw new Error('dup');
  await sendWelcomeEmail(form);
}

// ✅ Every line at the same altitude
async function onboardCustomer(input: unknown): Promise<OnboardingResult> {
  const form = parseOnboardingForm(input);
  if (!form.ok) return form;

  const email = canonicalEmail(form.value.email);
  if (await customers.exists(email)) return failure('already-registered');

  const customer = await customers.create({ ...form.value, email });
  await notifier.sendWelcome(customer);
  return success(customer);
}
```

### Parameters: three positional, at most

```ts
// ❌ Which string is which? What's the 0? The `true`?
createUser('Ada', 'Lovelace', 'ada@example.com', 0, true, 'en-GB');

// ✅ Named at the call site. Order-independent. Self-documenting.
createUser({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email,
  referralCredits: 0,
  marketingOptIn: true,
  locale: 'en-GB',
});
```

Guidelines:

- **0–2 parameters:** positional is fine when the meaning is obvious (`add(a, b)`,
  `applyDiscount(price, discount)`).
- **3 parameters:** positional only if their types differ and the order is natural.
- **4 or more:** always an options object.
- **Same-typed neighbours** (`(from: string, to: string)`): use an object or branded types. It's too easy to swap
  them silently.

### Too many parameters is a design signal

If a function genuinely needs eight inputs, some of them probably belong together:

```ts
// ❌
function scheduleMeeting(title, startDate, startTime, endDate, endTime, timezone, organizerId, organizerEmail) {}

// ✅ The parameters were hiding two concepts
function scheduleMeeting(title: string, slot: TimeSlot, organizer: Participant) {}
```

---

## 19. Logs Are Data, Not Prose

Logs are read by machines first (search, alerting, dashboards) and by humans second. Write them for both.

### Structured, not interpolated

```ts
// ❌ Unsearchable. Unparseable. Every format is different.
console.log(`User ${userId} failed to pay invoice ${invoiceId}: ${error.message}`);

// ✅ A stable event name and queryable fields
logger.warn('payment.failed', {
  userId,
  invoiceId,
  amount: invoice.total,
  reason: error.kind,
});
```

You can now query `event = "payment.failed" AND reason = "card-declined"`, group by `userId`, and alert on the
rate. You can't do any of that with the first version.

### Stable event names

Use `domain.action[.outcome]` names (`order.created`, `payment.failed`, `export.completed`) and treat them like
API names: don't rename them casually, because dashboards and alerts depend on them.

### Context flows, it isn't repeated

```ts
// ✅ Bind request-scoped context once
const requestLogger = logger.child({ requestId, userId });

requestLogger.info('checkout.started', { cartSize: cart.items.length });
requestLogger.info('checkout.completed', { orderId });
```

### Logging belongs to the shell

The pure core (§3) **does not log**. It returns values, including errors as values (§7), and the imperative shell
decides what is worth recording.

```ts
// Shell
const outcome = checkout(cart, now);
if (!outcome.ok) {
  logger.info('checkout.rejected', { cartId: cart.id, reason: outcome.error.kind });
}
```

If you feel the need to log inside a pure function, it's probably hiding a decision that should be part of its
return type.

### Levels mean something

| Level   | Meaning                                                  |
| ------- | -------------------------------------------------------- |
| `error` | Someone should be woken up, or this needs a ticket.      |
| `warn`  | Unexpected but handled; watch the rate.                  |
| `info`  | Significant business events. The story of what happened. |
| `debug` | Developer detail. Off in production by default.          |

### Never log secrets or personal data

No tokens, passwords, full card numbers or raw request bodies. Redact at the logger level with an allowlist of
safe fields, not by hoping every call site remembers.

---

## 20. Formatting Is Not a Discussion

Whitespace, quote style, semicolons, trailing commas and import order are **decided once by a tool, and never
discussed again.**

- A **formatter** (Prettier) owns layout. Accept its defaults; every custom option is a future argument.
- A **linter** (ESLint with `typescript-eslint`) owns correctness and the rules in this manifesto:
  `no-floating-promises`, `no-explicit-any`, `switch-exhaustiveness-check`, `consistent-type-imports`, import
  boundaries.
- **Format on save** in the editor, and **check in CI**. A PR that fails formatting doesn't get reviewed.
- **Zero warnings.** A warning everyone ignores is noise that hides the one that matters. Either fix it or turn the
  rule off on purpose.
- Until a tool decides, **match the surrounding code** and don't reformat lines you didn't change.
- In this repo the tools are **Biome** (`biome.json`): `npm run lint` checks, `npm run format` fixes. CI runs the
  check; warnings count as failures, so fix them or turn the rule off with a comment/reason in the config.

### Code review is for intent

```
❌ "nit: missing trailing comma"
❌ "can we use single quotes here?"

✅ "This name says `users` but it only contains admins. `admins`?"
✅ "Could this boolean be a discriminated union? `isLoading && isError` looks possible."
✅ "This does I/O inside `calculateTotal`. Can we lift the fetch to the caller?"
```

Every minute spent discussing formatting is a minute not spent on what this manifesto is about.

---

## The Short Version

1. **Intent over implementation.** Read like the requirement.
2. **Types over comments.** `PositiveInteger`, not `/* positive */ number`.
3. **Pure over stateful.** Push effects to the edges.
4. **Interfaces over classes.** Shapes over hierarchies.
5. **Full names over abbreviations.** `request`, not `req`.
6. **Values over exceptions.** Put failure in the signature.
7. **Flat over nested.** Guard clauses and narrow types.
8. **Parse over validate.** Trust is established once.
9. **Boring over clever.** The reader is the customer.
10. **Make illegal states unrepresentable.** The best bug is one that can't compile.
11. **Tests are specifications.** Name them after behaviour and use fakes over mocks.
12. **Async reads top to bottom.** Run independent work in parallel, never leave a promise floating, and let the
    caller cancel.
13. **Exports are an API.** Keep the surface small, enter through one front door, and avoid cycles.
14. **Types clarify.** A generic must link two positions, and boring types beat clever ones.
15. **Small functions, named arguments.** Keep one level of abstraction per function and use an object for four
    or more parameters.
16. **Logs are data.** Use stable event names and structured fields, and log in the shell, never in the core.
17. **Formatting is automated.** Review intent, not whitespace.

> _Write code for the reader. The compiler will understand it either way._
