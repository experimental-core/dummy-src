import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  Alert,
  Dimensions,
  StatusBar,
  Platform,
} from 'react-native';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';
import AudioRecord from 'react-native-audio-record';
import { Buffer } from 'buffer';
import { TextDecoder } from 'text-decoding';
import {
  MODEL_NAME,
  WEBSOCKET_HOST,
  WEBSOCKET_PATH,
  API_KEY,
  AUDIO_SAMPLE_RATE,
} from '../../config/config';

const { width, height } = Dimensions.get('window');

export default function Main() {
  // WebSocket and connection states
  const wsRef = useRef<WebSocket | null>(null);
  const isRecording = useRef(false);
  const [connectionStatus, setConnectionStatus] =
    useState<string>('disconnected');
  const [isConnecting, setIsConnecting] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  let currentSound: Sound | null = null;

  // Audio states
  const [isRecordingState, setIsRecordingState] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Ready to connect');

  // Audio response handling
  const audioInstanceRef = useRef<Sound | null>(null);

  // Initialize audio and auto-connect
  useEffect(() => {
    initializeAudio();
    return cleanup;
  }, []);

  const initializeAudio = useCallback(() => {
    try {
      // Initialize AudioRecord
      AudioRecord.init({
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6, // VOICE_RECOGNITION
        wavFile: 'record.wav',
      });

      // Set up audio data handler
      AudioRecord.on('data', handleAudioData);

      // Enable playback through the speaker
      Sound.setCategory('Playback');

      console.log('Audio initialized successfully');
    } catch (error) {
      console.error('Error initializing audio:', error);
    }
  }, []);

  const handleAudioData = useCallback((data: string) => {
    if (!isRecording.current) {
      return;
    }

    try {
      // const pcm = base64ToInt16(data);
      console.log('📡 Sending audio chunk, length:', data.length);
      sendToGemini(data);
    } catch (error) {
      console.error('Error processing audio data:', error);
    }
  }, []);

  const cleanup = useCallback(() => {
    try {
      AudioRecord.stop();
    } catch (e) {
      // Ignore if already stopped
    }

    if (audioInstanceRef.current) {
      audioInstanceRef.current.release();
      audioInstanceRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
    }
  }, []);
  // WebSocket connection management
  const openSession = useCallback(() => {
    const url = `wss://${WEBSOCKET_HOST}${WEBSOCKET_PATH}?key=${API_KEY}`;
    console.log('🔌 WebSocketService: Attempting to connect to:', url);

    setIsConnecting(true);
    setConnectionStatus('connecting');
    setConnectionError(null);
    setStatusMessage('Connecting to Gemini Live...');

    let ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('✅ WebSocket connection opened');
      setConnectionStatus('connected');
      setIsConnecting(false);
      setStatusMessage('Connected - Initializing...');

      // Send the setup/config message first
      const setupMessage = {
        setup: {
          model: MODEL_NAME,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Kore',
                },
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: 'You are a helpful AI assistant. Respond naturally in a conversational tone. Keep responses concise but engaging.',
              },
            ],
          },
        },
      };

      try {
        ws.send(JSON.stringify(setupMessage));
        console.log(
          'Setup message sent:',
          JSON.stringify(setupMessage, null, 2),
        );

        // Add timeout for setup completion
        setTimeout(() => {
          if (
            !setupComplete &&
            wsRef.current === ws &&
            ws.readyState === WebSocket.OPEN
          ) {
            console.log('⚠️ Setup timeout - forcing setup completion');
            setSetupComplete(true);
            setStatusMessage('✅ Ready! Tap to speak (timeout fallback)');
          }
        }, 10000); // 10 second timeout
      } catch (error) {
        console.error('Error sending setup message:', error);
        handleConnectionError('Failed to send setup message');
      }
    };

    ws.onmessage = event => {
      try {
        // Handle both binary and string data
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
          handleBinaryData(event.data);
        } else if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          handleReceivedMessage(message);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    };

    ws.onerror = error => {
      console.error('[WS] error event:', error);
      handleConnectionError('WebSocket connection error');
    };

    ws.onclose = event => {
      console.log('WebSocket closed:', event.code, event.reason);
      setConnectionStatus('disconnected');
      setSetupComplete(false);
      setIsConnecting(false);
      setStatusMessage('Disconnected');
      stopRecording();
    };

    wsRef.current = ws;
  }, []);

  const handleConnectionError = useCallback((error: string) => {
    console.error('Connection error:', error);
    setConnectionError(error);
    setConnectionStatus('error');
    setIsConnecting(false);
    setStatusMessage('Connection failed');
  }, []);

  // Handle binary data from WebSocket
  const handleBinaryData = async (data: ArrayBuffer | Blob) => {
    let bytes;
    if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      bytes = new Uint8Array(data);
    }

    const looksLikeJson =
      bytes.length > 0 && (bytes[0] === 123 || bytes[0] === 91);

    if (looksLikeJson) {
      const textDecoder = new TextDecoder('utf-8');
      const jsonText = textDecoder.decode(bytes);
      try {
        const jsonData = JSON.parse(jsonText);
        handleReceivedMessage(jsonData);
      } catch (error) {
        console.error('Error parsing binary JSON:', error);
      }
    } else {
      console.log('ELSE :🎵 Received audio data from Gemini');
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      playAudioResponseFromBuffer(arrayBuffer);
    }
  };

  // Handle received JSON messages
  const handleReceivedMessage = (message: any) => {
    console.log('📨 Received message type:', Object.keys(message));
    console.log('Full message:', JSON.stringify(message, null, 2));

    if (message.setupComplete !== undefined) {
      console.log('✅ Setup completed - ready for voice conversation!');
      setSetupComplete(true);
      setStatusMessage('✅ Ready! Tap to speak');
      return;
    }

    // Handle server content (Gemini's responses)
    if (message.serverContent) {
      console.log('📨 Received server content from Gemini');

      // Handle model turn with audio/text response
      if (message.serverContent.modelTurn?.parts) {
        message.serverContent.modelTurn.parts.forEach(
          (part: any, index: number) => {
            console.log(`Processing part ${index + 1}:`, Object.keys(part));

            // Handle text responses (distinguish between thoughts and actual responses)
            if (part.text && !part.thought) {
              console.log('📝 Actual text response:', part.text);
            }

            // Handle thoughts (internal reasoning)
            if (part.text && part.thought) {
              console.log('🤔 Gemini thought:', part.text);
            }

            // Handle audio responses (inline data)
            if (part.inlineData?.data) {
              console.log('🎵 Audio response received!', {
                mimeType: part.inlineData.mimeType,
                dataLength: part.inlineData.data?.length,
              });

              try {
                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                const arrayBuffer = audioBuffer.buffer.slice(
                  audioBuffer.byteOffset,
                  audioBuffer.byteOffset + audioBuffer.byteLength,
                );

                playAudioResponseFromBuffer(arrayBuffer);
                console.log('✅ Audio sent to output service for playback');
              } catch (error) {
                console.error('❌ Error processing audio data:', error);
              }
            }
          },
        );
      }

      // Handle input transcription (what user said)
      if (message.serverContent.inputTranscription?.text) {
        const userText = message.serverContent.inputTranscription.text;
        console.log('🎤 User said:', userText);
      }

      // Handle turn completion
      if (message.serverContent.turnComplete) {
        console.log('✅ Gemini finished speaking - ready for next input');
        setIsPlaying(false);
        if (setupComplete) {
          setStatusMessage('Ready - Tap to speak');
        }
      }
    }

    // Handle errors
    if (message.error) {
      console.error('❌ Gemini error:', message.error);
      handleConnectionError(message.error.message || 'Server error');
    }
  };

  // Audio playback using react-native-sound
  const playAudioResponse = useCallback(
    async (base64AudioData: string) => {
      if (!base64AudioData) return;

      try {
        setIsPlaying(true);
        setStatusMessage('🔊 Playing Gemini response...');

        // Clean up previous audio instance
        if (audioInstanceRef.current) {
          audioInstanceRef.current.release();
          audioInstanceRef.current = null;
        }

        // Convert base64 PCM to audio buffer
        const audioBuffer = Buffer.from(base64AudioData, 'base64');
        console.log('Audio buffer size:', audioBuffer.length);

        // For react-native-sound, we need to save to a file first
        // This is a simplified approach - in production, you might want to use react-native-fs
        playAudioFromBuffer(audioBuffer);
      } catch (error) {
        console.error('Error playing audio response:', error);
        setIsPlaying(false);
        setStatusMessage('Error playing audio');
      }
    },
    [setupComplete],
  );

  // Alternative method for direct buffer playback
  const playAudioResponseFromBuffer = useCallback(
    async (arrayBuffer: ArrayBuffer) => {
      let audioQueue = [];
      audioQueue.push(arrayBuffer);

      if (isPlaying) return;

      try {
        const totalLength = audioQueue.reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0,
        );
        const combinedBuffer = new ArrayBuffer(totalLength);
        const combinedView = new Uint8Array(combinedBuffer);

        let offset = 0;
        for (const chunk of audioQueue) {
          const chunkView = new Uint8Array(chunk);
          combinedView.set(chunkView, offset);
          offset += chunk.byteLength;
        }
        audioQueue = [];
        setIsPlaying(true);
        setStatusMessage('🔊 Playing Gemini response...');

        console.log('Playing audio from buffer, size:', arrayBuffer.byteLength);

        // Convert ArrayBuffer to Buffer
        // const buffer = Buffer.from(arrayBuffer);
        playAudioFromBuffer(combinedBuffer);
      } catch (error) {
        console.error('Error playing audio from buffer:', error);
        setIsPlaying(false);
        setStatusMessage('Error playing audio');
      }
    },
    [],
  );

  // Common audio playback logic
  const playAudioFromBuffer = useCallback(
    async (audioData: ArrayBuffer) => {
      return new Promise<void>(async (resolve, reject) => {
        try {
          // Create a simple WAV header for PCM data
          // const wavBuffer = createWavBuffer(buffer, AUDIO_SAMPLE_RATE, 1, 16);

          if (audioInstanceRef.current) {
            audioInstanceRef.current.release();
            audioInstanceRef.current = null;
          }
          let finalAudioData: ArrayBuffer;
          finalAudioData = audioData;

          const buffer = Buffer.from(finalAudioData);
          const base64Audio = buffer.toString('base64');
          let fileExtension = '.wav';

          const tempFilePath = `${
            RNFS.CachesDirectoryPath
          }/gemini_audio_${Date.now()}${fileExtension}`;
          await RNFS.writeFile(tempFilePath, base64Audio, 'base64');

          currentSound = new Sound(tempFilePath, '', error => {
            if (error) {
              console.error('AudioOutputService: Error loading sound:', error);
              reject(error);
              return;
            }

            console.log('AudioOutputService: ✅ Playing Gemini response...');
            currentSound?.play(success => {
              console.log(
                'AudioOutpuService: ✅ Playback finished, success:',
                success,
              );

              // Cleanup
              currentSound?.release();
              currentSound = null;

              // Delete temporary file after a delay to ensure playback is complete
              setTimeout(() => {
                RNFS.unlink(tempFilePath).catch(err =>
                  console.warn(
                    'AudioOutputService: Error deleting temp file:',
                    err,
                  ),
                );
              }, 1000);
              if (success) {
                resolve();
              } else {
                reject(new Error('Playback failed'));
              }
            });
          });
        } catch (error) {
          reject(error);
          console.error('Error in audio playback:', error);
          setIsPlaying(false);
          setStatusMessage('Error playing audio');
        }
      });
    },
    [setupComplete],
  );

  // Helper function to create WAV buffer from PCM data
  const createWavBuffer = (
    pcmBuffer: Buffer,
    sampleRate: number,
    channels: number,
    bitDepth: number,
  ): Buffer => {
    const length = pcmBuffer.length;
    const buffer = Buffer.alloc(44 + length);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + length, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE((sampleRate * channels * bitDepth) / 8, 28);
    buffer.writeUInt16LE((channels * bitDepth) / 8, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(length, 40);

    // PCM data
    pcmBuffer.copy(buffer, 44);

    return buffer;
  };

  // Recording controls
  const startRecording = useCallback(async () => {
    if (!setupComplete) {
      Alert.alert('Not Ready', 'Please wait for connection to be established.');
      return;
    }

    if (isRecordingState) {
      await stopRecording();
      return;
    }

    try {
      AudioRecord.start();
      isRecording.current = true;
      setIsRecordingState(true);
      console.log('🎤 Started recording');
    } catch (error) {
      console.error('Error starting recording:', error);
      Alert.alert(
        'Recording Error',
        'Could not start microphone: ' + error.message,
      );
      setStatusMessage('Recording error');
    }
  }, [setupComplete, isRecordingState]);

  const sendTurnComplete = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not open, cannot send turn complete');
      return;
    }

    try {
      const message = {
        realtimeInput: {
          turnComplete: true,
        },
      };

      console.log('🏁 Sending turn complete signal to Gemini');
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending turn complete:', error);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!isRecordingState) return;

    try {
      setStatusMessage('Stopping microphone...');

      isRecording.current = false;
      const filePath = await AudioRecord.stop();
      setIsRecordingState(false);

      // Send turn complete signal to Gemini
      sendTurnComplete();

      if (setupComplete) {
        setStatusMessage('🤔 Processing... Gemini is thinking');
      }

      console.log('🛑 Stopped recording, saved file:', filePath);
    } catch (error) {
      console.error('Error stopping recording:', error);
      setIsRecordingState(false);
      isRecording.current = false;
    }
  }, [isRecordingState, setupComplete, sendTurnComplete]);

  const connectToGemini = useCallback(async () => {
    if (connectionStatus === 'connected') {
      setStatusMessage('Disconnecting...');
      await stopRecording();
      if (wsRef.current) {
        wsRef.current.close();
      }
      return;
    }

    try {
      setConnectionError(null);
      console.log('🔌 Starting connection to Gemini Live...');
      openSession();
    } catch (error) {
      console.error('❌ Error connecting to Gemini:', error);
      handleConnectionError(error.message || 'Unknown connection error');
      Alert.alert('Connection Error', error.message);
    }
  }, [connectionStatus, openSession, stopRecording, handleConnectionError]);

  // Send PCM chunk over the open WebSocket
  const sendToGemini = useCallback((pcm: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not open, dropping chunk');
      return;
    }

    try {
      // Convert Int16Array → base64 for transport
      // const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const base64 = Buffer.from(pcm).toString('base64');

      const message = {
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${AUDIO_SAMPLE_RATE}`,
            data: base64,
          },
        },
      };

      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending audio to Gemini:', error);
    }
  }, []);

  // UI helper functions
  const getStatusColor = useCallback(() => {
    if (connectionError) return '#ff6b6b';
    if (isConnecting) return '#ffa726';
    if (connectionStatus === 'connected') {
      return setupComplete ? '#4caf50' : '#ff9800';
    }
    return '#9e9e9e';
  }, [connectionStatus, setupComplete, isConnecting, connectionError]);

  const getRecordingButtonColor = useCallback(() => {
    if (!setupComplete) return '#bdbdbd';
    return isRecordingState ? '#f44336' : '#4caf50';
  }, [setupComplete, isRecordingState]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a1a" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Gemini Live Audio</Text>
        <View
          style={[
            styles.statusIndicator,
            { backgroundColor: getStatusColor() },
          ]}
        />
      </View>

      {/* Status Section */}
      <View style={styles.statusSection}>
        <Text style={[styles.statusText, { color: getStatusColor() }]}>
          {statusMessage}
        </Text>

        {connectionError && (
          <Text style={styles.errorText}>{connectionError}</Text>
        )}

        {!setupComplete && connectionStatus === 'connected' && (
          <Text style={styles.setupText}>Setting up session...</Text>
        )}
      </View>

      {/* Main Controls */}
      <View style={styles.controlsContainer}>
        {/* Connection Button */}
        <TouchableOpacity
          style={[
            styles.connectionButton,
            {
              backgroundColor:
                connectionStatus === 'connected' ? '#f44336' : '#4caf50',
              opacity: isConnecting ? 0.7 : 1,
            },
          ]}
          onPress={connectToGemini}
          disabled={isConnecting}
        >
          <Text style={styles.connectionButtonText}>
            {isConnecting
              ? 'Connecting...'
              : connectionStatus === 'connected'
              ? 'Disconnect'
              : 'Connect to Gemini'}
          </Text>
        </TouchableOpacity>

        {/* Recording Button */}
        {setupComplete && (
          <TouchableOpacity
            style={[
              styles.recordingButton,
              {
                backgroundColor: getRecordingButtonColor(),
                transform: [{ scale: isRecordingState ? 1.1 : 1.0 }],
              },
            ]}
            onPress={startRecording}
            disabled={!setupComplete || isPlaying}
          >
            <Text style={styles.recordingButtonText}>
              {isRecordingState ? '🛑 Stop' : '🎤 Speak'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        {isRecordingState && (
          <Text style={styles.recordingIndicator}>🎤 Recording...</Text>
        )}
        {isPlaying && (
          <Text style={styles.playingText}>🔊 Gemini is speaking...</Text>
        )}
        <Text style={styles.footerText}>Simple Audio Chat - No WebRTC</Text>
      </View>
    </View>
  );
}

// Helper function
function base64ToInt16(base64: string): Int16Array {
  const buf = Buffer.from(base64, 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    paddingTop: Platform.OS === 'ios' ? 50 : StatusBar.currentHeight + 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    textAlign: 'center',
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: 10,
  },
  statusSection: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 10,
  },
  errorText: {
    fontSize: 14,
    color: '#ff6b6b',
    textAlign: 'center',
    marginBottom: 10,
  },
  setupText: {
    fontSize: 14,
    color: '#ff9800',
    textAlign: 'center',
    marginTop: 10,
  },
  controlsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 30,
  },
  connectionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 25,
    minWidth: 200,
  },
  connectionButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  recordingButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  recordingButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
  footer: {
    padding: 20,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
  },
  recordingIndicator: {
    fontSize: 16,
    color: '#f44336',
    textAlign: 'center',
    marginBottom: 10,
    fontWeight: '600',
  },
  playingText: {
    fontSize: 16,
    color: '#2196f3',
    textAlign: 'center',
    marginBottom: 10,
    fontWeight: '600',
  },
});
