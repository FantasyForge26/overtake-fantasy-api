import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { createLeague } from '@/lib/api';

type Format = 'redraft' | 'dynasty';

export default function CreateLeagueScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [format, setFormat] = useState<Format>('redraft');
  const [maxManagers, setMaxManagers] = useState(10);
  const [loading, setLoading] = useState(false);

  function decrement() {
    setMaxManagers((v) => Math.max(4, v - 1));
  }

  function increment() {
    setMaxManagers((v) => Math.min(20, v + 1));
  }

  async function handleCreate() {
    if (!name.trim() || loading) return;
    setLoading(true);
    try {
      await createLeague(name.trim(), format, maxManagers);
      router.back();
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Create League</Text>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* League Name */}
      <Text style={styles.label}>League Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="League name"
        placeholderTextColor="#555"
        autoCorrect={false}
      />

      {/* Format */}
      <Text style={styles.label}>Format</Text>
      <View style={styles.formatRow}>
        {(['redraft', 'dynasty'] as Format[]).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.formatCard, format === f && styles.formatCardSelected]}
            onPress={() => setFormat(f)}
            activeOpacity={0.8}
          >
            <Text style={[styles.formatText, format === f && styles.formatTextSelected]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Max Managers */}
      <Text style={styles.label}>Max Managers</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity style={styles.stepperButton} onPress={decrement} activeOpacity={0.8}>
          <Text style={styles.stepperButtonText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{maxManagers}</Text>
        <TouchableOpacity style={styles.stepperButton} onPress={increment} activeOpacity={0.8}>
          <Text style={styles.stepperButtonText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Create Button */}
      <TouchableOpacity
        style={[styles.createButton, (!name.trim() || loading) && styles.createButtonDisabled]}
        onPress={handleCreate}
        activeOpacity={0.85}
        disabled={!name.trim() || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.createButtonText}>Create League</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    paddingHorizontal: 20,
    paddingTop: 60,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 32,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  closeButton: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  label: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 16,
    marginBottom: 24,
  },
  formatRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  formatCard: {
    flex: 1,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#2A2A2A',
    paddingVertical: 14,
    alignItems: 'center',
  },
  formatCardSelected: {
    borderColor: '#E10600',
  },
  formatText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '600',
  },
  formatTextSelected: {
    color: '#fff',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    alignSelf: 'flex-start',
    marginBottom: 40,
  },
  stepperButton: {
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  stepperButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 22,
  },
  stepperValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    minWidth: 36,
    textAlign: 'center',
  },
  createButton: {
    backgroundColor: '#E10600',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 'auto',
    marginBottom: 32,
  },
  createButtonDisabled: {
    opacity: 0.45,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
