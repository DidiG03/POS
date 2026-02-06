# Memory Leak Testing Guide

**Last Updated**: 2025-01-09

## 🔍 Memory Monitoring

The POS system includes built-in memory monitoring to detect potential memory leaks.

---

## 📊 How It Works

### Automatic Monitoring

Memory monitoring runs automatically in development mode, or when `MEMORY_MONITORING=true` is set:

- **Takes snapshots** every 60 seconds
- **Tracks memory usage** (heap, RSS, external)
- **Detects trends** (increasing, decreasing, stable)
- **Alerts** if memory grows > 50MB over 10 checks (potential leak)

### Memory Stats

Tracked metrics:
- **Heap Used**: JavaScript heap memory in use
- **Heap Total**: Total JavaScript heap allocated
- **RSS**: Resident Set Size (total memory used by process)
- **External**: C++ objects bound to JavaScript objects

---

## 🧪 Testing for Memory Leaks

### Method 1: Use Admin Panel (Easiest)

1. **Open Admin Panel** → **Settings**
2. **Scroll to "Memory Monitoring"** section
3. **Watch the stats** over time:
   - **Trend**: Should be "Stable" or "Decreasing"
   - **⚠️ Increasing**: Potential memory leak
4. **Export snapshot** for detailed analysis

### Method 2: Monitor in Console

Memory usage is logged to console every minute:
```
[Memory Monitor] Heap: 45.23MB | RSS: 125.67MB
```

Watch for:
- **Steady increase** over time = potential leak
- **Sudden spikes** that don't decrease = potential leak

### Method 3: Chrome DevTools (Electron)

1. **Open DevTools** (Ctrl+Shift+I / Cmd+Option+I)
2. **Go to "Memory" tab**
3. **Take Heap Snapshots**:
   - Click "Take heap snapshot"
   - Use app for a while
   - Take another snapshot
   - Compare snapshots
4. **Look for**:
   - Growing number of objects
   - Objects not being garbage collected
   - Retained size increasing

---

## 🚨 Common Memory Leak Patterns

### 1. **Intervals Not Cleared**

**Problem**:
```typescript
setInterval(() => {
  // Do something
}, 1000);
// Never cleared = memory leak
```

**Solution**:
```typescript
const interval = setInterval(() => {
  // Do something
}, 1000);
// Cleanup:
clearInterval(interval);
```

**Check in code**: All `setInterval` calls should have corresponding `clearInterval`

### 2. **Event Listeners Not Removed**

**Problem**:
```typescript
window.addEventListener('click', handler);
// Never removed = memory leak
```

**Solution**:
```typescript
window.addEventListener('click', handler);
// Cleanup:
window.removeEventListener('click', handler);
```

**Check in code**: All `addEventListener` calls should have corresponding `removeEventListener`

### 3. **React useEffect Missing Cleanup**

**Problem**:
```typescript
useEffect(() => {
  setInterval(() => {}, 1000);
  // No cleanup = memory leak
}, []);
```

**Solution**:
```typescript
useEffect(() => {
  const interval = setInterval(() => {}, 1000);
  return () => clearInterval(interval); // Cleanup
}, []);
```

**Check in code**: All `useEffect` with timers/listeners should return cleanup function

### 4. **Closures Holding References**

**Problem**:
```typescript
function createHandler() {
  const largeData = new Array(1000000);
  return () => {
    // Handler holds reference to largeData
  };
}
```

**Solution**: Avoid holding large objects in closures

---

## 🔧 Memory Leak Testing Steps

### Step 1: Baseline

1. **Start the app**
2. **Wait 1-2 minutes** for stabilization
3. **Note initial memory**: Check admin panel or console
4. **Take heap snapshot** (if using DevTools)

### Step 2: Simulate Usage

1. **Log in** as a user
2. **Take orders** (create 10-20 tickets)
3. **Process payments**
4. **Navigate between pages** (Tables, Reports, etc.)
5. **Repeat** multiple times

### Step 3: Wait and Monitor

1. **Let app idle** for 10-15 minutes
2. **Monitor memory** every minute
3. **Check trend** in admin panel

### Step 4: Analyze Results

**Good Signs** ✅:
- Memory stabilizes after usage
- Trend shows "Stable" or "Decreasing"
- No continuous growth

**Bad Signs** ⚠️:
- Memory keeps growing
- Trend shows "Increasing"
- Peak memory keeps rising
- Alerts in console about leaks

---

## 📈 Interpreting Memory Stats

### Normal Memory Usage

- **Heap Used**: 30-100 MB (depends on features)
- **RSS**: 100-300 MB (depends on OS)
- **Trend**: Stable or Decreasing

### Potential Leak Indicators

- **Memory growth**: > 10MB per hour during idle
- **Peak memory**: Continuously increasing
- **Trend**: "Increasing" for extended period
- **Alerts**: Console warnings about leaks

### Acceptable Patterns

- **Initial spike**: Memory may spike on startup (normal)
- **Usage spikes**: Memory increases during active use (normal)
- **Recovery**: Memory decreases after activity stops (normal)

---

## 🐛 Known Areas to Check

### High-Risk Components

1. **TablesPage**: Polling intervals, event listeners
2. **OrderPage**: Timer for table duration, event listeners
3. **KdsPage**: Polling for tickets, event listeners
4. **ReportsPage**: Auto-refresh intervals
5. **SSE connections**: EventSource cleanup
6. **IPC handlers**: Event listener cleanup

### Already Protected

✅ **TablesPage**: Intervals cleared in useEffect cleanup
✅ **OrderPage**: Timer cleared in useEffect cleanup
✅ **KdsPage**: Polling cancelled properly
✅ **SSE**: EventSource closed properly
✅ **IPC**: Listeners cleaned up on window close

---

## 🔬 Advanced Testing

### Heap Profiling

1. **Open DevTools** → **Memory** tab
2. **Select "Heap Profiler"**
3. **Take snapshot**
4. **Use app for 10 minutes**
5. **Take another snapshot**
6. **Compare**: Look for growing object counts

### Performance Profiling

1. **Open DevTools** → **Performance** tab
2. **Start recording**
3. **Use app** for 5 minutes
4. **Stop recording**
5. **Look for**: Increasing memory timeline

### Load Testing

1. **Create many orders** (50-100)
2. **Process many payments**
3. **Navigate rapidly** between pages
4. **Monitor memory** during and after
5. **Check**: Does memory return to baseline?

---

## 🛠️ Tools

### Built-in Monitoring

- **Admin Panel**: Real-time memory stats
- **Console Logs**: Automatic memory logging
- **Snapshot Export**: Detailed JSON export

### Chrome DevTools

- **Memory Tab**: Heap snapshots, timeline
- **Performance Tab**: Memory timeline
- **Task Manager**: Process memory usage

### External Tools

- **Electron DevTools**: Built into Electron
- **Node.js Inspector**: `node --inspect`
- **Process Monitor**: OS-level monitoring

---

## 📝 Testing Checklist

- [ ] Baseline memory recorded
- [ ] App used normally for 15+ minutes
- [ ] Memory trend checked (should be stable)
- [ ] Multiple login/logout cycles tested
- [ ] Many orders created and processed
- [ ] Navigation between pages tested
- [ ] Idle period monitored (10+ minutes)
- [ ] No continuous memory growth observed
- [ ] Heap snapshots compared (if using DevTools)
- [ ] Memory exports reviewed

---

## 🚨 If Leak Detected

1. **Check console** for leak warnings
2. **Export memory snapshot** via admin panel
3. **Review snapshot** for growing object counts
4. **Identify component** causing growth
5. **Check cleanup** in useEffect/componentWillUnmount
6. **Fix missing cleanup** (intervals, listeners, subscriptions)
7. **Re-test** to confirm fix

---

## 💡 Best Practices

1. **Always cleanup** intervals/timeouts in useEffect
2. **Always remove** event listeners
3. **Avoid closures** holding large objects
4. **Use cleanup functions** in React components
5. **Monitor memory** during development
6. **Test under load** before production

---

## 📚 Additional Resources

- [Electron Memory Management](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Chrome DevTools Memory Profiling](https://developer.chrome.com/docs/devtools/memory-problems/)
- [React Memory Leaks Guide](https://react.dev/learn/escape-hatches#memory-leaks)

---

*For questions or issues, check the memory stats in Admin Panel → Settings → Memory Monitoring*
