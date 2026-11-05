import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiError, api, clearSession, getApiBaseUrl, setApiBaseUrl } from './src/api';

type User = { id: string; username: string; displayName: string; role: 'admin' | 'member' };
type TripSummary = {
  id: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: string;
  coverKind: string;
  ownerName?: string;
  memberCount?: number;
  canEdit?: boolean;
  revision: number;
};
type Person = { id: string; name: string; role: string };
type Activity = { id: string; date: string; time: string; title: string; location: string; note: string; done: boolean; people: string[]; type: string };
type ShoppingItem = { id: string; name: string; quantity: string; category: string; assignee: string; done: boolean };
type GearItem = { id: string; name: string; quantity: string; scope: string; assignee: string; ready: string[] };
type TripState = {
  revision: number;
  trip: TripSummary & { description: string; note: string };
  people: Person[];
  activities: Activity[];
  meals: { id: string; date: string; slot: string; title: string; cookId: string; ingredients: string; notes: string }[];
  shopping: ShoppingItem[];
  gear: GearItem[];
  vehicles: { id: string; name: string; driver: string; meeting: string }[];
};
type TripEnvelope = { trip: TripSummary; state: TripState; permissions: { canEdit: boolean; personId: string } };
type Palette = { background: string; surface: string; ink: string; muted: string; line: string; green: string; yellow: string; coral: string; danger: string; soft: string };

const palettes: { light: Palette; dark: Palette } = {
  light: { background: '#fffcf6', surface: '#ffffff', ink: '#3e3a39', muted: '#77716c', line: '#e7dfd3', green: '#e4eddc', yellow: '#f6d27a', coral: '#efa28f', danger: '#a43b34', soft: '#f5f0e8' },
  dark: { background: '#242729', surface: '#303538', ink: '#f6f0e5', muted: '#c4bcb0', line: '#4b5051', green: '#3e5144', yellow: '#826b34', coral: '#8b5147', danger: '#ffaaa0', soft: '#383e40' }
};

const sections = [
  ['schedule', '行程'],
  ['meals', '料理'],
  ['shopping', '採買'],
  ['gear', '裝備'],
  ['crew', '旅伴']
] as const;
type Section = typeof sections[number][0];
const coverLabels: Record<string, string> = { camp: '營地帳篷', mountain: '山間旅途', lake: '湖畔水岸', night: '星空夜晚', forest: '森林小屋', beach: '海邊假期', sunrise: '日出山嵐' };
const dateLabel = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
};

function ActionButton({ label, onPress, palette, secondary = false, disabled = false }: { label: string; onPress: () => void; palette: Palette; secondary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: secondary ? palette.surface : palette.yellow, borderColor: palette.ink, opacity: disabled ? 0.55 : pressed ? 0.72 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: palette.ink }]}>{label}</Text>
    </Pressable>
  );
}

function Field({ value, onChangeText, placeholder, palette, secureTextEntry = false, autoCapitalize = 'sentences', keyboardType = 'default' }: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  palette: Palette;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  keyboardType?: 'default' | 'url' | 'numeric';
}) {
  return (
    <TextInput
      accessibilityLabel={placeholder}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      keyboardType={keyboardType}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={palette.muted}
      secureTextEntry={secureTextEntry}
      selectionColor={palette.coral}
      value={value}
      style={[styles.input, { backgroundColor: palette.surface, borderColor: palette.line, color: palette.ink }]}
    />
  );
}

function SwipeTripCard({ trip, palette, onOpen }: { trip: TripSummary; palette: Palette; onOpen: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const opened = useRef(false);
  const settle = (next: boolean) => {
    opened.current = next;
    Animated.spring(translateX, { toValue: next ? -92 : 0, useNativeDriver: true, stiffness: 280, damping: 27, mass: 0.8 }).start();
  };
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
    onPanResponderMove: (_event, gesture) => translateX.setValue(Math.max(-92, Math.min(0, (opened.current ? -92 : 0) + gesture.dx))),
    onPanResponderRelease: (_event, gesture) => settle(opened.current ? gesture.dx > 30 ? false : gesture.dx < -30 ? true : opened.current : gesture.dx < -38),
    onPanResponderTerminate: () => settle(opened.current)
  }), [translateX]);

  return (
    <View style={[styles.swipeShell, { backgroundColor: palette.green }]}>
      <Pressable accessibilityRole="button" onPress={onOpen} style={styles.swipeAction}>
        <Text style={[styles.swipeActionText, { color: palette.ink }]}>開啟</Text>
      </Pressable>
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX }] }}>
        <Pressable accessibilityRole="button" onPress={onOpen} style={[styles.tripCard, { backgroundColor: palette.surface, borderColor: palette.ink }]}>
          <View style={styles.tripCardTop}>
            <View style={[styles.coverMark, { backgroundColor: palette.green }]}>
              <Text style={[styles.coverEmoji, { color: palette.ink }]}>{trip.coverKind === 'lake' || trip.coverKind === 'beach' ? '⌁' : trip.coverKind === 'night' ? '✦' : '⌂'}</Text>
            </View>
            <View style={styles.tripMain}>
              <View style={styles.tripTitleRow}>
                <Text numberOfLines={1} style={[styles.tripTitle, { color: palette.ink }]}>{trip.title || '未命名旅行'}</Text>
                <Text style={[styles.statusPill, { backgroundColor: trip.status === 'completed' ? palette.green : palette.yellow, color: palette.ink }]}>{trip.status === 'completed' ? '回憶' : '規劃中'}</Text>
              </View>
              <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{trip.destination || '尚未填寫地點'}</Text>
              <Text style={[styles.meta, { color: palette.muted }]}>{dateLabel(trip.startDate)}{trip.startDate === trip.endDate ? '' : ` — ${dateLabel(trip.endDate)}`}</Text>
              <Text style={[styles.meta, { color: palette.muted }]}>{trip.memberCount || 0} 位旅伴 · {coverLabels[trip.coverKind] || coverLabels.camp}</Text>
            </View>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const palette = isDark ? palettes.dark : palettes.light;
  const [baseUrl, setBaseUrl] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'setup' | 'register'>('login');
  const [screen, setScreen] = useState<'auth' | 'home' | 'trip' | 'settings'>('auth');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [tripDetail, setTripDetail] = useState<TripEnvelope | null>(null);
  const [selectedSection, setSelectedSection] = useState<Section>('schedule');
  const [filter, setFilter] = useState<'all' | 'planning' | 'completed'>('all');
  const [serverDraft, setServerDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchTrips = useCallback(async () => {
    const result = await api<{ trips: TripSummary[] }>('/api/trips');
    setTrips(Array.isArray(result.trips) ? result.trips : []);
  }, []);

  const checkSession = useCallback(async () => {
    const result = await api<{ user: User | null; needsSetup: boolean }>('/api/session');
    setNeedsSetup(result.needsSetup);
    if (result.user) {
      setUser(result.user);
      setScreen('home');
      await fetchTrips();
    } else {
      setUser(null);
      setAuthMode(result.needsSetup ? 'setup' : 'login');
      setScreen('auth');
    }
  }, [fetchTrips]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const currentUrl = await getApiBaseUrl();
        if (!active) return;
        setBaseUrl(currentUrl);
        setServerDraft(currentUrl);
        await checkSession();
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '無法讀取伺服器設定。');
      }
    })();
    return () => { active = false; };
  }, [checkSession]);

  async function submitAuth() {
    setBusy(true);
    setError('');
    try {
      const path = authMode === 'login' ? '/api/login' : authMode === 'setup' ? '/api/setup' : '/api/register';
      const body = authMode === 'login' ? { username: username.trim().toLowerCase(), password } : {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        password
      };
      await api(path, { method: 'POST', body });
      setPassword('');
      await checkSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登入失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      if (screen === 'trip' && tripDetail) {
        const updated = await api<TripEnvelope>(`/api/trips/${encodeURIComponent(tripDetail.trip.id)}`);
        setTripDetail(updated);
      } else {
        await fetchTrips();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重新整理失敗。');
    } finally {
      setRefreshing(false);
    }
  }

  async function openTrip(trip: TripSummary) {
    setBusy(true);
    setError('');
    try {
      const detail = await api<TripEnvelope>(`/api/trips/${encodeURIComponent(trip.id)}`);
      setTripDetail(detail);
      setSelectedSection('schedule');
      setScreen('trip');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法開啟旅行。');
    } finally {
      setBusy(false);
    }
  }

  async function updateTripState(update: (state: TripState) => void) {
    if (!tripDetail || !user || busy || !tripDetail.permissions.canEdit) return;
    setBusy(true);
    setError('');
    try {
      const nextState = JSON.parse(JSON.stringify(tripDetail.state)) as TripState;
      update(nextState);
      const updated = await api<TripEnvelope>(`/api/trips/${encodeURIComponent(tripDetail.trip.id)}`, {
        method: 'PUT',
        body: { expectedUserId: user.id, revision: tripDetail.trip.revision, state: nextState }
      });
      setTripDetail(updated);
      await fetchTrips();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '尚未儲存，請重新載入後再試。');
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          setTripDetail(await api<TripEnvelope>(`/api/trips/${encodeURIComponent(tripDetail.trip.id)}`));
        } catch {
          setError('旅行已在其他裝置更新，且無法重新載入。請返回旅行列表後再開啟。');
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveServerAddress() {
    setBusy(true);
    setError('');
    try {
      const normalized = await setApiBaseUrl(serverDraft);
      setBaseUrl(normalized);
      setUser(null);
      setTripDetail(null);
      setScreen('auth');
      await checkSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法儲存伺服器位址。');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await api('/api/logout', { method: 'POST', body: {} });
      await clearSession();
      setUser(null);
      setTrips([]);
      setTripDetail(null);
      setScreen('auth');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登出失敗。');
    } finally {
      setBusy(false);
    }
  }

  const visibleTrips = trips.filter(trip => filter === 'all' || (trip.status === 'completed' ? 'completed' : 'planning') === filter);
  const stylesFor = useMemo(() => makeStyles(palette), [palette]);

  function showFieldError(message: string) {
    Alert.alert('無法完成操作', message, [{ text: '知道了' }]);
  }

  function toggleActivity(activity: Activity) {
    void updateTripState(state => {
      const target = state.activities.find(item => item.id === activity.id);
      if (target) target.done = !target.done;
    });
  }

  function toggleShopping(item: ShoppingItem) {
    void updateTripState(state => {
      const target = state.shopping.find(row => row.id === item.id);
      if (target) target.done = !target.done;
    });
  }

  function toggleGear(item: GearItem) {
    if (!tripDetail) return;
    const personId = tripDetail.permissions.personId;
    if (item.scope === 'shared' && item.assignee !== personId) return;
    if (item.scope === 'personal' && item.assignee && item.assignee !== personId) return;
    void updateTripState(state => {
      const target = state.gear.find(row => row.id === item.id);
      if (!target) return;
      target.ready = target.ready.includes(personId) ? target.ready.filter(id => id !== personId) : [...target.ready, personId];
    });
  }

  function renderAuth() {
    const title = authMode === 'setup' ? '建立管理員帳號' : authMode === 'register' ? '註冊旅伴帳號' : '登入日子拾光';
    const submit = authMode === 'setup' ? '建立帳號' : authMode === 'register' ? '註冊並登入' : '登入';
    return (
      <ScrollView contentContainerStyle={stylesFor.authScroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.authCard, { backgroundColor: palette.surface, borderColor: palette.ink }]}>
          <Text style={[styles.eyebrow, { color: palette.muted }]}>LITTLE MOMENTS · MOBILE</Text>
          <Text style={[styles.heading, { color: palette.ink }]}>{title}</Text>
          <Text style={[styles.body, { color: palette.muted }]}>{authMode === 'setup' ? '第一次啟用時建立唯一的管理員帳號。' : '登入後就能開啟你和旅伴共同規劃的旅行。'}</Text>
          <Field value={username} onChangeText={setUsername} placeholder="帳號名稱" palette={palette} autoCapitalize="none" />
          {authMode !== 'login' && <Field value={displayName} onChangeText={setDisplayName} placeholder="顯示名稱" palette={palette} />}
          <Field value={password} onChangeText={setPassword} placeholder="密碼（至少 12 個字元）" palette={palette} secureTextEntry autoCapitalize="none" />
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          <ActionButton label={busy ? '請稍候…' : submit} onPress={() => void submitAuth()} palette={palette} disabled={busy || !username || !password || (authMode !== 'login' && !displayName)} />
          {needsSetup ? null : (
            <Pressable accessibilityRole="button" onPress={() => { setError(''); setAuthMode(authMode === 'register' ? 'login' : 'register'); }}>
              <Text style={[styles.link, { color: palette.ink }]}>{authMode === 'register' ? '已有帳號？返回登入' : '建立旅伴帳號'}</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" onPress={() => { setServerDraft(baseUrl); setScreen('settings'); }}>
            <Text style={[styles.link, { color: palette.muted }]}>伺服器：{baseUrl || '設定伺服器位址'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderHome() {
    const counts = {
      all: trips.length,
      planning: trips.filter(trip => trip.status !== 'completed').length,
      completed: trips.filter(trip => trip.status === 'completed').length
    };
    return (
      <>
        <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
          <View>
            <Text style={[styles.eyebrow, { color: palette.muted }]}>MY LITTLE MOMENTS</Text>
            <Text numberOfLines={1} style={[styles.topTitle, { color: palette.ink }]}>{user?.displayName} 的旅行</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="設定伺服器" onPress={() => { setServerDraft(baseUrl); setScreen('settings'); }} style={styles.iconButton}>
            <Text style={[styles.iconText, { color: palette.ink }]}>⚙</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={stylesFor.pageContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={palette.ink} />}
        >
          <Text style={[styles.heading, { color: palette.ink }]}>一起把旅程，過成喜歡的樣子。</Text>
          <Text style={[styles.body, { color: palette.muted }]}>向左滑動旅行卡片，快速開啟手冊。</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {([['all', '全部'], ['planning', '規劃中'], ['completed', '回憶']] as const).map(([key, label]) => (
              <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)} style={[styles.filterChip, { backgroundColor: filter === key ? palette.yellow : palette.surface, borderColor: palette.line }]}>
                <Text style={[styles.filterText, { color: palette.ink }]}>{label} {counts[key]}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {busy && !trips.length ? <ActivityIndicator size="large" color={palette.ink} style={styles.loading} /> : null}
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          {!busy && !error && !visibleTrips.length ? (
            <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <Text style={[styles.cardTitle, { color: palette.ink }]}>還沒有旅行</Text>
              <Text style={[styles.body, { color: palette.muted }]}>在網頁版建立第一趟旅行後，就能在這裡一起編輯。</Text>
            </View>
          ) : visibleTrips.map(trip => <SwipeTripCard key={trip.id} trip={trip} palette={palette} onOpen={() => void openTrip(trip)} />)}
        </ScrollView>
        <View style={[styles.bottomBar, { borderTopColor: palette.line, backgroundColor: palette.surface }]}>
          <Text numberOfLines={1} style={[styles.bottomUser, { color: palette.muted }]}>{user?.displayName} · {baseUrl}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void logout()}><Text style={[styles.link, { color: palette.ink }]}>登出</Text></Pressable>
        </View>
      </>
    );
  }

  function renderTripContent() {
    if (!tripDetail) return null;
    const state = tripDetail.state;
    const personName = (id: string) => state.people.find(person => person.id === id)?.name || '未分配';
    if (selectedSection === 'schedule') {
      return state.activities.length ? state.activities.slice().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).map(activity => (
        <Pressable key={activity.id} accessibilityRole={tripDetail.permissions.canEdit ? 'checkbox' : 'text'} accessibilityState={{ checked: activity.done }} disabled={!tripDetail.permissions.canEdit || busy} onPress={() => toggleActivity(activity)} style={[styles.listCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
          <Text style={[styles.itemTitle, { color: palette.ink }]}>{activity.done ? '✓ ' : ''}{activity.title}</Text>
          <Text style={[styles.meta, { color: palette.muted }]}>{dateLabel(activity.date)} · {activity.time} · {activity.location || '地點未設定'}</Text>
          {activity.note ? <Text style={[styles.body, { color: palette.muted }]}>{activity.note}</Text> : null}
        </Pressable>
      )) : <EmptyState palette={palette} text="還沒有行程，這趟旅程的安排可以從網頁版新增。" />;
    }
    if (selectedSection === 'meals') {
      return state.meals.length ? state.meals.map(meal => (
        <View key={meal.id} style={[styles.listCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
          <Text style={[styles.itemTitle, { color: palette.ink }]}>{meal.title}</Text>
          <Text style={[styles.meta, { color: palette.muted }]}>{dateLabel(meal.date)} · {meal.slot} · {personName(meal.cookId)}</Text>
          {meal.ingredients ? <Text style={[styles.body, { color: palette.muted }]}>食材：{meal.ingredients}</Text> : null}
          {meal.notes ? <Text style={[styles.body, { color: palette.muted }]}>{meal.notes}</Text> : null}
        </View>
      )) : <EmptyState palette={palette} text="還沒有料理安排。" />;
    }
    if (selectedSection === 'shopping') {
      return state.shopping.length ? state.shopping.map(item => (
        <Pressable key={item.id} accessibilityRole={tripDetail.permissions.canEdit ? 'checkbox' : 'text'} accessibilityState={{ checked: item.done }} disabled={!tripDetail.permissions.canEdit || busy} onPress={() => toggleShopping(item)} style={[styles.listCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
          <Text style={[styles.itemTitle, { color: palette.ink }]}>{item.done ? '✓ ' : '○ '}{item.name}</Text>
          <Text style={[styles.meta, { color: palette.muted }]}>{item.quantity} · {item.category} · {personName(item.assignee)}</Text>
        </Pressable>
      )) : <EmptyState palette={palette} text="採買清單還沒有項目。" />;
    }
    if (selectedSection === 'gear') {
      return state.gear.length ? state.gear.map(item => {
        const personId = tripDetail.permissions.personId;
        const checked = item.ready.includes(personId);
        const canPack = item.scope !== 'shared' || item.assignee === personId;
        const canPackPersonal = item.scope !== 'personal' || !item.assignee || item.assignee === personId;
        const enabled = tripDetail.permissions.canEdit && canPack && canPackPersonal;
        return (
          <Pressable key={item.id} accessibilityRole={enabled ? 'checkbox' : 'text'} accessibilityState={{ checked }} disabled={!enabled || busy} onPress={() => toggleGear(item)} style={[styles.listCard, { backgroundColor: palette.surface, borderColor: palette.line, opacity: enabled ? 1 : 0.8 }]}>
            <Text style={[styles.itemTitle, { color: palette.ink }]}>{checked ? '✓ ' : '○ '}{item.name}</Text>
            <Text style={[styles.meta, { color: palette.muted }]}>{item.quantity} · {item.scope === 'shared' ? '共用' : '個人'} · {personName(item.assignee)}</Text>
          </Pressable>
        );
      }) : <EmptyState palette={palette} text="裝備清單還沒有項目。" />;
    }
    return state.people.map(person => (
      <View key={person.id} style={[styles.listCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
        <Text style={[styles.itemTitle, { color: palette.ink }]}>{person.name}</Text>
        <Text style={[styles.meta, { color: palette.muted }]}>{person.role || '旅伴'}</Text>
      </View>
    ));
  }

  function renderTrip() {
    if (!tripDetail) return null;
    const trip = tripDetail.trip;
    return (
      <>
        <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
          <Pressable accessibilityRole="button" onPress={() => { setScreen('home'); setTripDetail(null); }} style={styles.backButton}>
            <Text style={[styles.link, { color: palette.ink }]}>‹ 旅行</Text>
          </Pressable>
          <View style={styles.tripHeader}>
            <Text numberOfLines={1} style={[styles.topTitle, { color: palette.ink }]}>{trip.title}</Text>
            <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{trip.destination || dateLabel(trip.startDate)}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="重新整理" onPress={() => void refresh()} style={styles.iconButton}><Text style={[styles.iconText, { color: palette.ink }]}>↻</Text></Pressable>
        </View>
        <ScrollView
          contentContainerStyle={stylesFor.pageContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={palette.ink} />}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionRow}>
            {sections.map(([key, label]) => (
              <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: selectedSection === key }} onPress={() => setSelectedSection(key)} style={[styles.sectionTab, { backgroundColor: selectedSection === key ? palette.yellow : palette.surface, borderColor: selectedSection === key ? palette.ink : palette.line }]}>
                <Text style={[styles.sectionLabel, { color: palette.ink }]}>{label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          {busy ? <Text style={[styles.saving, { color: palette.muted }]}>同步中…</Text> : null}
          {renderTripContent()}
        </ScrollView>
      </>
    );
  }

  function renderSettings() {
    return (
      <ScrollView contentContainerStyle={stylesFor.authScroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.authCard, { backgroundColor: palette.surface, borderColor: palette.ink }]}>
          <Pressable accessibilityRole="button" onPress={() => setScreen(user ? 'home' : 'auth')}><Text style={[styles.link, { color: palette.ink }]}>‹ 返回</Text></Pressable>
          <Text style={[styles.heading, { color: palette.ink }]}>連接你的伺服器</Text>
          <Text style={[styles.body, { color: palette.muted }]}>手機和伺服器需在同一個可信任的內網。實體手機請填伺服器電腦的內網 IP，例如 http://192.168.1.20:5182。</Text>
          <Field value={serverDraft} onChangeText={setServerDraft} placeholder="http://192.168.1.20:5182" palette={palette} autoCapitalize="none" keyboardType="url" />
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          <ActionButton label={busy ? '連線中…' : '儲存並連線'} onPress={() => void saveServerAddress()} palette={palette} disabled={busy || !serverDraft.trim()} />
          <Text style={[styles.caption, { color: palette.muted }]}>帳號密碼只傳送至上方設定的伺服器。Session cookie 儲存在裝置安全儲存區。請勿把服務公開至網際網路；HTTP 只適合可信任的私人網路。</Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {screen === 'settings' ? renderSettings() : screen === 'auth' ? renderAuth() : screen === 'trip' ? renderTrip() : renderHome()}
    </View>
  );
}

function EmptyState({ palette, text }: { palette: Palette; text: string }) {
  return <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.line }]}><Text style={[styles.body, { color: palette.muted }]}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  authScroll: { flexGrow: 1, justifyContent: 'center', padding: 22 },
  authCard: { width: '100%', maxWidth: 520, alignSelf: 'center', borderWidth: 1.5, borderRadius: 24, padding: 24, gap: 14 },
  eyebrow: { fontSize: 11, letterSpacing: 1.4, fontWeight: '800' },
  heading: { fontSize: 28, lineHeight: 36, fontWeight: '800' },
  topTitle: { fontSize: 19, lineHeight: 26, fontWeight: '800', maxWidth: 270 },
  body: { fontSize: 15, lineHeight: 23 },
  meta: { fontSize: 13, lineHeight: 19 },
  input: { minHeight: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 15, fontSize: 16 },
  button: { minHeight: 52, borderWidth: 1.5, borderRadius: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  buttonText: { fontSize: 16, fontWeight: '800' },
  link: { fontSize: 14, fontWeight: '700', paddingVertical: 8 },
  error: { borderWidth: 1, borderColor: '#c06d5d', borderRadius: 12, padding: 12, fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 18 },
  topBar: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, borderBottomWidth: 1, gap: 10 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 24, fontWeight: '700' },
  pageContent: { padding: 18, paddingBottom: 30, gap: 14 },
  filterRow: { gap: 8, paddingVertical: 2 },
  filterChip: { minHeight: 40, borderWidth: 1, borderRadius: 22, justifyContent: 'center', paddingHorizontal: 14 },
  filterText: { fontSize: 13, fontWeight: '700' },
  swipeShell: { height: 142, overflow: 'hidden', borderRadius: 19, justifyContent: 'center' },
  swipeAction: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 92, alignItems: 'center', justifyContent: 'center' },
  swipeActionText: { fontWeight: '800', fontSize: 14 },
  tripCard: { minHeight: 142, borderWidth: 1.5, borderRadius: 19, padding: 12, justifyContent: 'center' },
  tripCardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  coverMark: { width: 68, height: 88, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  coverEmoji: { fontSize: 35, fontWeight: '700' },
  tripMain: { flex: 1, gap: 4 },
  tripTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tripTitle: { flex: 1, fontSize: 17, fontWeight: '800' },
  statusPill: { overflow: 'hidden', borderRadius: 14, paddingVertical: 4, paddingHorizontal: 7, fontSize: 10, fontWeight: '800' },
  emptyCard: { borderWidth: 1, borderRadius: 18, padding: 20, gap: 8 },
  cardTitle: { fontSize: 19, fontWeight: '800' },
  loading: { padding: 24 },
  bottomBar: { minHeight: 56, borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, gap: 8 },
  bottomUser: { flex: 1, fontSize: 11 },
  backButton: { paddingVertical: 8, paddingRight: 4 },
  tripHeader: { flex: 1, alignItems: 'center' },
  sectionRow: { gap: 8, paddingVertical: 2 },
  sectionTab: { minHeight: 44, minWidth: 70, borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  sectionLabel: { fontSize: 14, fontWeight: '800' },
  listCard: { borderWidth: 1, borderRadius: 16, padding: 15, gap: 5 },
  itemTitle: { fontSize: 16, fontWeight: '800', lineHeight: 23 },
  saving: { fontSize: 12, textAlign: 'right' }
});

function makeStyles(palette: Palette) {
  return StyleSheet.create({
    pageContent: { padding: 18, paddingBottom: 30, gap: 14 },
    authScroll: { flexGrow: 1, justifyContent: 'center', padding: 22 }
  });
}
