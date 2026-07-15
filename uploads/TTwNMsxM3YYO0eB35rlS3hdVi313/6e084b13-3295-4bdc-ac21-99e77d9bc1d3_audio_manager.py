import pyaudio
import queue
import threading
from RealtimeSTT import AudioToTextRecorder

class AudioManager:
    def __init__(self, on_realtime_text=None):
        self.pa = pyaudio.PyAudio()
        self.is_playing = False
        self.interrupt_flag = False
        self.text_queue = queue.Queue()
        
        # Initialize the recorder with callbacks for interruption and real-time updates
        self.recorder = AudioToTextRecorder(
            model="tiny", 
            language="en",
            wake_words="hey_jarvis",
            wakeword_backend="openwakeword",
            spinner=False,
            on_recording_start=self._on_speech_started,
            on_realtime_transcription_update=on_realtime_text, # Real-time typing effect
            silero_sensitivity=0.9, # EXTREMELY high threshold to ignore noise/echo
            post_speech_silence_duration=0.5,
            realtime_processing_pause=0.1, 
            enable_realtime_transcription=True 
        )
        
        # Start background listening using a custom thread calling .text() in a loop
        self.listen_thread = threading.Thread(target=self._listen_loop, daemon=True)
        self.listen_thread.start()

    def _listen_loop(self):
        """Continuously records and transcribes in the background."""
        while True:
            try:
                # This blocks until speech finishes and transcribes
                text = self.recorder.text()
                text = text.strip()
                if text:
                    self.text_queue.put(text)
            except Exception as e:
                print(f"STT Error: {e}")
                break

    def _on_speech_started(self):
        """Callback from RealtimeSTT when VAD detects you starting to speak."""
        if self.is_playing:
            self.interrupt_flag = True

    def play_audio_stream(self, audio_query_generator):
        """Plays audio and gets interrupted if speech is detected."""
        self.is_playing = True
        self.interrupt_flag = False
        
        # Clear any stale text from the queue before playing
        while not self.text_queue.empty():
            self.text_queue.get()

        stream = self.pa.open(format=pyaudio.paInt16,
                              channels=1,
                              rate=44100,
                              output=True)

        try:
            for chunk in audio_query_generator:
                if self.interrupt_flag:
                    break
                if chunk:
                    stream.write(chunk)
        finally:
            self.is_playing = False
            stream.stop_stream()
            stream.close()
            # If we just finished playing, we might want to clear the queue 
            # if we suspect the interrupt was caused by the AI's own echo.
            # But if it was a legitimate interrupt, the user's speech is currently 
            # being transcribed and will land in the queue soon. We leave the queue alone.

    def listen_and_recognize(self):
        """Uses the continuous transcription queue."""
        # Block until the background thread puts text into the queue
        text = self.text_queue.get()
        return text

    def cleanup(self):
        try:
            self.recorder.stop()
            self.recorder.shutdown()
        except:
            pass
        self.pa.terminate()
