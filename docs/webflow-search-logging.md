# Search query logging

The overview page has an **Unmet demand** section that ranks searches performed
on the live site which returned no results. That is the highest-signal topic
list the system can produce: a technician looked for a code, the library did not
have it, and they wanted it. Demonstrated demand, not a guess.

Nothing populates it yet. This is the change that does.

## What this is not

The site search **already works**. There is a complete implementation in the
Webflow site footer that calls `search_fault_codes` over PostgREST with the
publishable key, debounced, with URL sync and error states. Verified live:
`3216` returns the DD15 page at rank 3.57, and `DEF derate` matches it by
symptom keyword.

So this is an addition to something working, not a repair. Applying it must not
regress the existing behaviour.

## The change

In the Webflow site footer custom code, inside the existing search IIFE, find
the `.then` that renders results:

```js
.then(function(r){if(q===last)draw(r||[],q)})
```

Replace it with:

```js
.then(function(r){if(q===last){draw(r||[],q);log(q,(r||[]).length)}})
```

Then add this `log` function alongside the other helpers in the same IIFE:

```js
function log(q,n){
  // Fire-and-forget. A failed log must never surface to the person searching:
  // they are mid-diagnosis and this is analytics, not a feature they asked for.
  try{
    fetch('https://YOUR-PROJECT.supabase.co/rest/v1/search_queries',{
      method:'POST',
      headers:{apikey:K,Authorization:'Bearer '+K,'Content-Type':'application/json',Prefer:'return=minimal'},
      body:JSON.stringify({q:q.slice(0,200),result_count:n}),
      keepalive:true
    }).catch(function(){})
  }catch(e){}
}
```

`K` is the publishable key already defined in that IIFE. Substitute the real
project URL for `YOUR-PROJECT`.

## Why this is safe to expose

`search_queries` has RLS enabled with exactly one policy: `INSERT` for `anon`.
There is no `SELECT` policy, so a visitor can add a row and cannot read the
table back — the query log is write-only from the browser. The console reads it
with the secret key, server-side.

The column caps `q` at 200 characters and the snippet truncates before sending,
so a pathological query string cannot be used to write arbitrary volumes.

No IP address, no user agent, no identifier is stored. The table holds the query
text, the result count and a timestamp. That is everything needed to rank unmet
demand and nothing that would make this personal data worth protecting.

`keepalive: true` matters: a technician who searches and immediately clicks a
result would otherwise have the request cancelled by the navigation, which would
systematically drop exactly the searches that succeeded.

## Verifying

After publishing, search for something the library does not have, then:

```sql
select q, result_count, created_at from search_queries order by created_at desc limit 10;
```

The row should appear with `result_count = 0`, and it should show up on the
console's overview page under Unmet demand.
