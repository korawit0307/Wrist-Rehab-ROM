import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  Alert,
  StatusBar,
  SafeAreaView,
  Platform,
} from 'react-native';
import { Gyroscope } from 'expo-sensors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';

// ==========================================
// CONSTANTS & CONFIGURATIONS
// ==========================================
const STORAGE_KEY = '@wrist_rehab_history_v1';
const SENSOR_INTERVAL_MS = 100; // Sensor sampling rate: 100ms (10Hz)

// Motion types for wrist rehabilitation
const EXERCISE_MODES = [
  { id: 'flexion', label: 'Flexion / Extension', icon: 'hand-wave-outline', axis: 'x' },
  { id: 'radial', label: 'Radial / Ulnar', icon: 'hand-back-right-outline', axis: 'y' },
  { id: 'pronation', label: 'Pronation / Supination', icon: 'rotate-3d-variant', axis: 'z' },
];

export default function App() {
  // ----------------------------------------
  // APP STATE
  // ----------------------------------------
  const [isSensorAvailable, setIsSensorAvailable] = useState(true);
  const [selectedMode, setSelectedMode] = useState(EXERCISE_MODES[0]);
  const [isRecording, setIsRecording] = useState(false);
  const [currentAngle, setCurrentAngle] = useState(0.0);
  const [maxAngle, setMaxAngle] = useState(0.0);
  const [liveRates, setLiveRates] = useState({ x: 0, y: 0, z: 0 });
  const [history, setHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // References for continuous tracking during active session
  const isRecordingRef = useRef(false);
  const selectedModeRef = useRef(selectedMode);
  const integratedAngleRef = useRef(0.0);
  const maxAngleRef = useRef(0.0);
  const lastTimestampRef = useRef(null);

  // Keep refs synchronized with active states
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    selectedModeRef.current = selectedMode;
  }, [selectedMode]);

  // ----------------------------------------
  // 1. LIFECYCLE: LOAD HISTORY & CHECK SENSOR
  // ----------------------------------------
  useEffect(() => {
    loadSessionHistory();
    checkSensorAvailability();

    // Configure update interval
    Gyroscope.setUpdateInterval(SENSOR_INTERVAL_MS);

    // Subscribe to gyroscope updates
    const subscription = Gyroscope.addListener((data) => {
      handleGyroscopeUpdate(data);
    });

    // Cleanup subscription on unmount to prevent memory leaks
    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  /**
   * Check if gyroscope hardware is available on the current device
   */
  const checkSensorAvailability = async () => {
    try {
      const available = await Gyroscope.isAvailableAsync();
      setIsSensorAvailable(available);
    } catch {
      setIsSensorAvailable(false);
    }
  };

  /**
   * Core numerical integration function to compute Angle from Angular Velocity.
   * Angular velocity in rad/s is converted to degrees/s, then multiplied by dt.
   */
  const handleGyroscopeUpdate = (data) => {
    const { x, y, z } = data;
    const now = Date.now();

    // Keep live angular rates for the live monitor HUD
    setLiveRates({
      x: isFinite(x) ? x : 0,
      y: isFinite(y) ? y : 0,
      z: isFinite(z) ? z : 0,
    });

    if (!isRecordingRef.current) {
      lastTimestampRef.current = now;
      return;
    }

    // Calculate elapsed time (dt) in seconds safely
    let dt = 0.1;
    if (lastTimestampRef.current) {
      dt = (now - lastTimestampRef.current) / 1000;
      // Guard against abnormal time pauses or tab switches
      if (dt <= 0 || dt > 1.0) {
        dt = SENSOR_INTERVAL_MS / 1000;
      }
    }
    lastTimestampRef.current = now;

    // Determine angular rate for the selected movement axis
    const axisKey = selectedModeRef.current.axis;
    const rawRateRad = data[axisKey] || 0;

    // Convert rad/s to degrees/s (1 rad = 180 / π degrees)
    const rateDegPerSec = rawRateRad * (180 / Math.PI);

    // Apply numerical integration (deadband threshold of 3°/s filters noise drift)
    if (Math.abs(rateDegPerSec) > 3.0) {
      integratedAngleRef.current += rateDegPerSec * dt;
    }

    const currentAbsoluteAngle = Math.abs(integratedAngleRef.current);
    if (currentAbsoluteAngle > maxAngleRef.current) {
      maxAngleRef.current = currentAbsoluteAngle;
      setMaxAngle(parseFloat(currentAbsoluteAngle.toFixed(1)));
    }

    setCurrentAngle(parseFloat(currentAbsoluteAngle.toFixed(1)));
  };

  // ----------------------------------------
  // 2. SESSION RECORDING CONTROLS
  // ----------------------------------------
  const handleStartSession = () => {
    integratedAngleRef.current = 0.0;
    maxAngleRef.current = 0.0;
    lastTimestampRef.current = Date.now();
    setCurrentAngle(0.0);
    setMaxAngle(0.0);
    setIsRecording(true);
  };

  const handleStopAndSave = async () => {
    setIsRecording(false);
    const recordedMax = maxAngleRef.current;

    if (recordedMax < 5.0) {
      Alert.alert(
        'Motion Too Low',
        'Minimal wrist displacement detected (< 5°). Would you still like to save this session?',
        [
          { text: 'Discard', style: 'cancel' },
          { text: 'Save Anyway', onPress: () => persistSession(recordedMax) },
        ]
      );
    } else {
      await persistSession(recordedMax);
    }
  };

  // ----------------------------------------
  // 3. ASYNCSTORAGE PERSISTENCE
  // ----------------------------------------
  const persistSession = async (finalMaxAngle) => {
    try {
      const newEntry = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        maxAngle: parseFloat(finalMaxAngle.toFixed(1)),
        exerciseName: selectedMode.label,
        rating: getRehabEvaluation(finalMaxAngle),
      };

      const updatedHistory = [newEntry, ...history];
      setHistory(updatedHistory);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedHistory));

      Alert.alert(
        'Session Saved! 🎉',
        `Recorded Max ROM: ${finalMaxAngle.toFixed(1)}°\nStatus: ${newEntry.rating.title}`
      );
    } catch {
      Alert.alert('Storage Error', 'Failed to save session data to local storage.');
    }
  };

  const loadSessionHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const rawData = await AsyncStorage.getItem(STORAGE_KEY);
      if (rawData !== null) {
        const parsed = JSON.parse(rawData);
        if (Array.isArray(parsed)) {
          setHistory(parsed);
        }
      }
    } catch {
      setHistory([]);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleClearHistory = () => {
    if (history.length === 0) return;

    Alert.alert(
      'Clear History',
      'Are you sure you want to delete all saved rehabilitation records? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              await AsyncStorage.removeItem(STORAGE_KEY);
              setHistory([]);
            } catch {
              Alert.alert('Error', 'Unable to clear history.');
            }
          },
        },
      ]
    );
  };

  // ----------------------------------------
  // 4. PERFORMANCE EVALUATION & FEEDBACK
  // ----------------------------------------
  const getRehabEvaluation = (angle) => {
    if (angle >= 60) {
      return {
        title: 'Optimal Mobility',
        color: '#10B981', // Emerald
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        message: 'Outstanding range of motion! Full functionality reached.',
      };
    } else if (angle >= 30) {
      return {
        title: 'Moderate ROM',
        color: '#3B82F6', // Blue
        badgeBg: 'rgba(59, 130, 246, 0.15)',
        message: 'Good functional progress. Continue gentle repetitions.',
      };
    } else {
      return {
        title: 'Limited Range',
        color: '#F59E0B', // Amber
        badgeBg: 'rgba(245, 158, 11, 0.15)',
        message: 'Stiffness detected. Warm up before expanding extension.',
      };
    }
  };

  const currentEval = getRehabEvaluation(maxAngle);

  // Format timestamp helper
  const formatDateTime = (isoString) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown date';
    }
  };

  // ----------------------------------------
  // 5. RENDER UI
  // ----------------------------------------
  const renderHistoryItem = ({ item }) => (
    <View style={styles.historyCard}>
      <View style={styles.historyHeader}>
        <View style={styles.historyIconWrapper}>
          <MaterialCommunityIcons name="history" size={20} color="#818CF8" />
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.historyExerciseTitle}>{item.exerciseName}</Text>
          <Text style={styles.historyDateText}>{formatDateTime(item.timestamp)}</Text>
        </View>
        <View style={[styles.historyBadge, { backgroundColor: item.rating.badgeBg }]}>
          <Text style={[styles.historyBadgeText, { color: item.rating.color }]}>
            {item.rating.title}
          </Text>
        </View>
      </View>

      <View style={styles.historyDetails}>
        <Text style={styles.historyAngleLabel}>Max Deflection</Text>
        <Text style={styles.historyAngleValue}>{item.maxAngle}°</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

      {/* HEADER SECTION */}
      <View style={styles.headerBar}>
        <View style={styles.titleContainer}>
          <MaterialCommunityIcons name="arm-flex-outline" size={28} color="#6366F1" />
          <View style={{ marginLeft: 10 }}>
            <Text style={styles.appTitle}>WristRehab ROM</Text>
          </View>
        </View>

        {!isSensorAvailable && (
          <View style={styles.sensorWarningPill}>
            <MaterialCommunityIcons name="alert-circle-outline" size={14} color="#F59E0B" />
            <Text style={styles.sensorWarningText}>Simulator Mode</Text>
          </View>
        )}
      </View>

      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        renderItem={renderHistoryItem}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* EXERCISE MODE SELECTOR */}
            <Text style={styles.sectionHeader}>TARGET EXERCISE</Text>
            <View style={styles.modeSelectorRow}>
              {EXERCISE_MODES.map((mode) => {
                const isSelected = selectedMode.id === mode.id;
                return (
                  <TouchableOpacity
                    key={mode.id}
                    disabled={isRecording}
                    onPress={() => setSelectedMode(mode)}
                    style={[
                      styles.modeButton,
                      isSelected && styles.modeButtonActive,
                      isRecording && !isSelected && styles.modeButtonDisabled,
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={mode.icon}
                      size={20}
                      color={isSelected ? '#6366F1' : '#94A3B8'}
                    />
                    <Text
                      style={[
                        styles.modeButtonText,
                        isSelected && styles.modeButtonTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {mode.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* LIVE DASHBOARD GAUGE CARD */}
            <View style={styles.mainMeterCard}>
              <View style={styles.meterStatusHeader}>
                <View style={styles.liveIndicatorRow}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: isRecording ? '#10B981' : '#64748B' },
                    ]}
                  />
                  <Text style={styles.liveStatusText}>
                    {isRecording ? 'SESSION IN PROGRESS' : 'STANDBY READY'}
                  </Text>
                </View>
                <Text style={styles.axisBadge}>Axis: {selectedMode.axis.toUpperCase()}</Text>
              </View>

              {/* Angle Metrics */}
              <View style={styles.metricValuesRow}>
                <View style={styles.metricBlock}>
                  <Text style={styles.metricLabel}>CURRENT ANGLE</Text>
                  <Text style={styles.currentAngleDisplay}>
                    {currentAngle.toFixed(1)}
                    <Text style={styles.unitText}>°</Text>
                  </Text>
                </View>

                <View style={styles.metricDivider} />

                <View style={styles.metricBlock}>
                  <Text style={styles.metricLabel}>PEAK (MAX ROM)</Text>
                  <Text style={styles.maxAngleDisplay}>
                    {maxAngle.toFixed(1)}
                    <Text style={styles.unitText}>°</Text>
                  </Text>
                </View>
              </View>

              {/* Progress Visualizer Bar */}
              <View style={styles.progressBarTrack}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${Math.min((currentAngle / 90) * 100, 100)}%`,
                      backgroundColor: currentEval.color,
                    },
                  ]}
                />
              </View>

              {/* Performance Status Badge */}
              <View
                style={[
                  styles.evaluationPill,
                  { backgroundColor: currentEval.badgeBg, borderColor: currentEval.color },
                ]}
              >
                <MaterialCommunityIcons
                  name="shield-check-outline"
                  size={16}
                  color={currentEval.color}
                />
                <Text style={[styles.evaluationPillText, { color: currentEval.color }]}>
                  {currentEval.title} — {currentEval.message}
                </Text>
              </View>

              {/* Gyroscope Raw Rates HUD */}
              <View style={styles.gyroHud}>
                <Text style={styles.gyroHudTitle}>Angular Velocity (rad/s):</Text>
                <View style={styles.gyroHudValues}>
                  <Text style={styles.gyroRateText}>X: {liveRates.x.toFixed(2)}</Text>
                  <Text style={styles.gyroRateText}>Y: {liveRates.y.toFixed(2)}</Text>
                  <Text style={styles.gyroRateText}>Z: {liveRates.z.toFixed(2)}</Text>
                </View>
              </View>
            </View>

            {/* ACTION CONTROLS */}
            <View style={styles.actionRow}>
              {!isRecording ? (
                <TouchableOpacity
                  style={[styles.primaryButton, styles.startButton]}
                  onPress={handleStartSession}
                  activeOpacity={0.8}
                >
                  <MaterialCommunityIcons name="play-circle" size={24} color="#FFFFFF" />
                  <Text style={styles.buttonText}>Start Session</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.primaryButton, styles.stopButton]}
                  onPress={handleStopAndSave}
                  activeOpacity={0.8}
                >
                  <MaterialCommunityIcons name="content-save-check" size={24} color="#FFFFFF" />
                  <Text style={styles.buttonText}>Stop & Save Record</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* HISTORY SECTION TITLE WITH CLEAR BUTTON */}
            <View style={styles.historyTitleRow}>
              <Text style={styles.sectionHeader}>SESSION HISTORY ({history.length})</Text>
              {history.length > 0 && (
                <TouchableOpacity onPress={handleClearHistory} style={styles.clearBtn}>
                  <MaterialCommunityIcons name="trash-can-outline" size={16} color="#EF4444" />
                  <Text style={styles.clearBtnText}>Clear All</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        }
        ListEmptyComponent={
          !isLoadingHistory && (
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons
                name="clipboard-text-clock-outline"
                size={44}
                color="#334155"
              />
              <Text style={styles.emptyTitle}>No Recorded Sessions Yet</Text>
              <Text style={styles.emptySubtitle}>
                Select an exercise mode above and tap "Start Session" to record your Range of Motion.
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

// ==========================================
// STYLESHEET (Dark Mode Modern Palette)
// ==========================================
const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: '#0B0F19',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderColor: '#1E293B',
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  appTitle: {
    fontSize: 19,
    fontWeight: '700',
    color: '#F8FAFC',
    letterSpacing: 0.4,
  },
  appSubtitle: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '400',
  },
  sensorWarningPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sensorWarningText: {
    color: '#F59E0B',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1.2,
    marginTop: 20,
    marginBottom: 10,
  },
  modeSelectorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  modeButton: {
    flex: 1,
    backgroundColor: '#161F30',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#24324D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    borderColor: '#6366F1',
  },
  modeButtonDisabled: {
    opacity: 0.4,
  },
  modeButtonText: {
    fontSize: 10.5,
    color: '#94A3B8',
    marginTop: 6,
    fontWeight: '500',
    textAlign: 'center',
  },
  modeButtonTextActive: {
    color: '#818CF8',
    fontWeight: '700',
  },
  mainMeterCard: {
    backgroundColor: '#161F30',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#24324D',
    padding: 20,
    marginTop: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  meterStatusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  liveIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 7,
  },
  liveStatusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  axisBadge: {
    backgroundColor: '#0F172A',
    color: '#818CF8',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  metricValuesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginBottom: 16,
  },
  metricBlock: {
    alignItems: 'center',
    flex: 1,
  },
  metricDivider: {
    width: 1,
    height: 48,
    backgroundColor: '#24324D',
  },
  metricLabel: {
    fontSize: 10.5,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: 4,
    letterSpacing: 0.8,
  },
  currentAngleDisplay: {
    fontSize: 38,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  maxAngleDisplay: {
    fontSize: 38,
    fontWeight: '800',
    color: '#6366F1',
  },
  unitText: {
    fontSize: 22,
    fontWeight: '400',
    color: '#94A3B8',
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: '#0F172A',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 14,
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  evaluationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 14,
  },
  evaluationPillText: {
    fontSize: 11.5,
    fontWeight: '600',
    marginLeft: 6,
    flexShrink: 1,
  },
  gyroHud: {
    backgroundColor: '#0B0F19',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  gyroHudTitle: {
    fontSize: 10,
    color: '#64748B',
    fontWeight: '600',
    marginBottom: 4,
  },
  gyroHudValues: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  gyroRateText: {
    fontSize: 11,
    color: '#94A3B8',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '500',
  },
  actionRow: {
    marginTop: 18,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  startButton: {
    backgroundColor: '#4F46E5',
  },
  stopButton: {
    backgroundColor: '#DC2626',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 8,
    letterSpacing: 0.4,
  },
  historyTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 26,
    marginBottom: 6,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  clearBtnText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
  historyCard: {
    backgroundColor: '#161F30',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#24324D',
    padding: 14,
    marginBottom: 10,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  historyIconWrapper: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyExerciseTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  historyDateText: {
    fontSize: 10.5,
    color: '#64748B',
    marginTop: 2,
  },
  historyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  historyBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  historyDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: '#1E293B',
    paddingTop: 8,
    marginTop: 2,
  },
  historyAngleLabel: {
    fontSize: 12,
    color: '#94A3B8',
  },
  historyAngleValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#818CF8',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#1E293B',
    borderStyle: 'dashed',
    borderRadius: 14,
    marginTop: 6,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#94A3B8',
    marginTop: 10,
  },
  emptySubtitle: {
    fontSize: 11.5,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 16,
  },
});
