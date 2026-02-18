import Foundation
import AVFoundation
import React

@objc(ExpoAudioStreamModule)
class AudioStreamModule: RCTEventEmitter {
    
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var isRecording = false
    private var recordingFormat: AVAudioFormat?
    
    override init() {
        super.init()
        setupAudioEngine()
    }
    
    private func setupAudioEngine() {
        audioEngine = AVAudioEngine()
        inputNode = audioEngine?.inputNode
    }
    
    @objc
    override static func requiresMainQueueSetup() -> Bool {
        return false
    }
    
    override func supportedEvents() -> [String]! {
        return ["AudioData", "AudioError", "RecordingStarted", "RecordingStopped"]
    }
    
    // MARK: - Audio Session Configuration
    
    private func configureAudioSession(options: [String: Any]) {
        
        let audioSession = AVAudioSession.sharedInstance()
        
        // Get iOS audio session options
        let iosOptions = options["ios"] as? [String: Any]
        let audioSessionOptions = iosOptions?["audioSession"] as? [String: Any]
        
        // Get category, mode, and options
        let categoryString = audioSessionOptions?["category"] as? String ?? "PlayAndRecord"
        let modeString = audioSessionOptions?["mode"] as? String ?? "VoiceChat"
        let categoryOptionsArray = audioSessionOptions?["categoryOptions"] as? [String] ?? ["DefaultToSpeaker", "AllowBluetooth"]
        
        // print("   Category: \(categoryString)")
        // print("   Mode: \(modeString)")
        // print("   Options: \(categoryOptionsArray)")
        
        // Always use PlayAndRecord for duplex
        let category: AVAudioSession.Category = .playAndRecord
        
        // VoiceChat mode is best for duplex communication
        let mode: AVAudioSession.Mode = .voiceChat
        
        // Convert category options - CRITICAL for duplex
        var sessionOptions: AVAudioSession.CategoryOptions = []
        for option in categoryOptionsArray {
            switch option {
            case "DefaultToSpeaker":
                sessionOptions.insert(.defaultToSpeaker)
            case "AllowBluetooth":
                sessionOptions.insert(.allowBluetooth)
            case "AllowBluetoothA2DP":
                sessionOptions.insert(.allowBluetoothA2DP)
            case "MixWithOthers":
                sessionOptions.insert(.mixWithOthers)
            case "DuckOthers":
                sessionOptions.insert(.duckOthers)
            default:
                break
            }
        }
        
        // Essential for duplex: DefaultToSpeaker and AllowBluetooth
        // sessionOptions.insert(.defaultToSpeaker)
        sessionOptions.insert(.allowBluetooth)
        
        do {
            // print("   Setting category for DUPLEX audio...")
            try audioSession.setCategory(category, mode: .voiceChat, options: sessionOptions)

            if #available(iOS 18.2, *) {
            print("🔁 Preferring echo-cancelled input (iOS 18.2+)")
            try audioSession.setPrefersEchoCancelledInput(true)
            }
            
            let sampleRate = options["sampleRate"] as? Double ?? 16000.0
            // print("   Setting preferred sample rate: \(sampleRate)Hz...")
            try audioSession.setPreferredSampleRate(sampleRate)
            
            // print("   Setting IO buffer duration for low latency...")
            try audioSession.setPreferredIOBufferDuration(0.01) // 10ms for better duplex
            
            // print("   Activating audio session...")
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            
            // Override output to speaker for duplex
            try audioSession.overrideOutputAudioPort(.speaker)
            
            // print("✅ Audio session configured successfully for DUPLEX")
            // print("   Actual sample rate: \(audioSession.sampleRate)Hz")
            // print("   IO buffer duration: \(audioSession.ioBufferDuration)s")
            // print("   Current route: \(audioSession.currentRoute)")
            // print("   Available inputs: \(audioSession.availableInputs?.count ?? 0)")
            
        } catch {
            // print("❌ Failed to configure audio session: \(error.localizedDescription)")
            sendEvent(withName: "AudioError", body: ["error": "Failed to configure audio session: \(error.localizedDescription)"])
        }
    }
    // MARK: - Recording Control
    
    @objc
    func startRecording(_ options: [String: Any],
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        // print("🎬 startRecording called with options: \(options)")
        
        if isRecording {
            // print("⚠️ Already recording")
            reject("ALREADY_RECORDING", "Recording is already in progress", nil)
            return
        }
        
        // Configure audio session
        // print("🔧 Configuring audio session...")
        configureAudioSession(options: options)
        
        // Get recording parameters
        let requestedSampleRate = options["sampleRate"] as? Double ?? 16000.0
        let channels = options["channels"] as? UInt32 ?? 1
        let encoding = options["encoding"] as? String ?? "pcm_16bit"
        
        // print("📝 Recording parameters:")
        // print("   - Sample rate: \(requestedSampleRate) Hz")
        // print("   - Channels: \(channels)")
        // print("   - Encoding: \(encoding)")
        
        // Validate encoding
        guard encoding == "pcm_16bit" else {
            // print("❌ Invalid encoding: \(encoding)")
            reject("INVALID_ENCODING", "Only pcm_16bit encoding is supported", nil)
            return
        }
        
        // Configure TARGET audio format
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: requestedSampleRate,
            channels: AVAudioChannelCount(channels),
            interleaved: true
        ) else {
            // print("❌ Failed to create target format")
            reject("FORMAT_ERROR", "Failed to create audio format", nil)
            return
        }
        
        // print("✅ Target format created: \(targetFormat.sampleRate)Hz, \(targetFormat.channelCount)ch")
        
        recordingFormat = targetFormat
        
        guard let inputNode = inputNode,
            let audioEngine = audioEngine else {
            // print("❌ Audio engine not initialized")
            reject("ENGINE_ERROR", "Audio engine not initialized", nil)
            return
        }
        
        let inputFormat = inputNode.outputFormat(forBus: 0)
        // print("🎤 Input node format: \(inputFormat.sampleRate)Hz, \(inputFormat.channelCount)ch")
        
        let bufferSize: AVAudioFrameCount = 1024
        // print("📏 Buffer size: \(bufferSize) frames")
        
        // Install tap
        // print("🔌 Installing tap on input node...")
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] (buffer, time) in
            // print("🎵 Tap callback received buffer with \(buffer.frameLength) frames")
            self?.processAudioBuffer(buffer: buffer, targetFormat: targetFormat)
        }
        
        // Start engine
        do {
            // print("🚀 Preparing and starting audio engine...")
            audioEngine.prepare()
            try audioEngine.start()
            
            isRecording = true
            // print("✅ Audio engine started successfully")
            
            sendEvent(withName: "RecordingStarted", body: ["success": true])
            resolve(["success": true])
            
        } catch {
            // print("❌ Failed to start audio engine: \(error.localizedDescription)")
            inputNode.removeTap(onBus: 0)
            reject("ENGINE_START_ERROR", error.localizedDescription, error)
        }
    }
    
    @objc
    func stopRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        if !isRecording {
            resolve(["success": true, "message": "No recording in progress"])
            return
        }
        
        // Remove tap and stop engine
        inputNode?.removeTap(onBus: 0)
        audioEngine?.stop()
        
        // DON'T deactivate audio session - keep it active for playback
        // The session should stay active for duplex communication
        // print("🎤 Recording stopped, keeping audio session active for playback")
        
        isRecording = false
        sendEvent(withName: "RecordingStopped", body: ["success": true])
        resolve(["success": true])
    }
    
    @objc
    func pauseRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        guard isRecording else {
            reject("NOT_RECORDING", "No recording in progress", nil)
            return
        }
        
        audioEngine?.pause()
        resolve(["success": true])
    }
    
    @objc
    func resumeRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        guard isRecording else {
            reject("NOT_RECORDING", "No recording in progress", nil)
            return
        }
        
        do {
            try audioEngine?.start()
            resolve(["success": true])
        } catch {
            reject("RESUME_ERROR", error.localizedDescription, error)
        }
    }
    
    @objc
    func isRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(["isRecording": isRecording])
    }
    
    @objc
    func getAudioSessionCategory(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        let session = AVAudioSession.sharedInstance()
        resolve([
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "sampleRate": session.sampleRate
        ])
    }
        
    private func processAudioBuffer(buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) {
        guard buffer.frameLength > 0 else {
            print("⚠️ Buffer has zero frames")
            return
        }
        
        // print("📥 Received buffer: \(buffer.frameLength) frames at \(buffer.format.sampleRate)Hz")
        
        var convertedBuffer: AVAudioPCMBuffer
        
        // Check if conversion is needed
        let needsConversion = buffer.format.sampleRate != targetFormat.sampleRate || 
                            buffer.format.commonFormat != targetFormat.commonFormat
        
        if needsConversion {
            // print("🔄 Conversion needed: \(buffer.format.sampleRate)Hz → \(targetFormat.sampleRate)Hz")
            
            guard let converter = AVAudioConverter(from: buffer.format, to: targetFormat) else {
                // print("❌ Failed to create audio converter")
                sendEvent(withName: "AudioError", body: ["error": "Failed to create audio converter"])
                return
            }
            
            // Calculate output capacity
            let ratio = targetFormat.sampleRate / buffer.format.sampleRate
            let outputFrameCapacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio))
            
            // print("📊 Conversion ratio: \(ratio), output capacity: \(outputFrameCapacity)")
            
            guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCapacity) else {
                // print("❌ Failed to create output buffer")
                sendEvent(withName: "AudioError", body: ["error": "Failed to create output buffer"])
                return
            }
            
            // Prepare for conversion
            var error: NSError?
            var inputProvided = false
            
            let inputBlock: AVAudioConverterInputBlock = { inNumPackets, outStatus in
                if inputProvided {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                
                inputProvided = true
                outStatus.pointee = .haveData
                return buffer
            }
            
            // Perform conversion
            let status = converter.convert(to: outputBuffer, error: &error, withInputFrom: inputBlock)
            
            // print("🔄 Conversion status: \(status.rawValue), output frames: \(outputBuffer.frameLength)")
            
            if let error = error {
                // print("❌ Conversion error: \(error.localizedDescription)")
                sendEvent(withName: "AudioError", body: ["error": "Conversion failed: \(error.localizedDescription)"])
                return
            }
            
            // FIX: Check status correctly - .haveData has rawValue of 1
            // Also accept .inputRanDry (rawValue 2) which means successful conversion but no more input
            if status != .haveData && status != .inputRanDry {
                print("❌ Conversion failed with status: \(status.rawValue)")
                return
            }
            
            if outputBuffer.frameLength == 0 {
                print("❌ Output buffer has zero frames after conversion")
                return
            }
            
            convertedBuffer = outputBuffer
            // print("✅ Conversion successful: \(convertedBuffer.frameLength) frames at \(convertedBuffer.format.sampleRate)Hz")
            
        } else {
            // print("ℹ️ No conversion needed, using original buffer")
            convertedBuffer = buffer
        }
        
        // Extract PCM data
        guard let pcmData = extractPCMData(from: convertedBuffer) else {
            // print("❌ Failed to extract PCM data")
            return
        }
        
        // print("📦 Extracted PCM data: \(pcmData.count) bytes")
        
        // Convert to base64
        let base64String = pcmData.base64EncodedString()
        // print("📝 Base64 string length: \(base64String.count)")
        
        // Prepare event data
        let eventData: [String: Any] = [
            "encoded": base64String,
            "frameLength": convertedBuffer.frameLength,
            "sampleRate": convertedBuffer.format.sampleRate,
            "channels": convertedBuffer.format.channelCount,
            "bitDepth": 16
        ]
        
        // print("📤 Sending AudioData event with \(pcmData.count) bytes")
        
        // Send event
        sendEvent(withName: "AudioData", body: eventData)
        
        // print("✅ AudioData event sent successfully")
    }
    
    @objc
    func deactivateAudioSession(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            // print("✅ Audio session deactivated")
            resolve(["success": true])
        } catch {
            // print("⚠️ Failed to deactivate audio session: \(error.localizedDescription)")
            reject("DEACTIVATE_ERROR", error.localizedDescription, error)
        }
    }
        
    private func extractPCMData(from buffer: AVAudioPCMBuffer) -> Data? {
        guard buffer.frameLength > 0 else {
            // print("❌ extractPCMData: Buffer has zero frames")
            return nil
        }
        
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        let bytesPerSample = MemoryLayout<Int16>.size
        
        // print("📊 Extracting PCM: \(frameLength) frames, \(channelCount) channels, interleaved: \(buffer.format.isInterleaved)")
        
        if buffer.format.isInterleaved {
            // Interleaved format (should be the case for Int16)
            guard let data = buffer.audioBufferList.pointee.mBuffers.mData else {
                // print("❌ extractPCMData: No data in buffer")
                return nil
            }
            
            let dataSize = frameLength * channelCount * bytesPerSample
            let extractedData = Data(bytes: data, count: dataSize)
            
            // print("✅ Extracted interleaved data: \(extractedData.count) bytes")
            return extractedData
            
        } else {
            // Non-interleaved format - need to interleave
            // print("🔄 Converting non-interleaved to interleaved format")
            
            let dataSize = frameLength * channelCount * bytesPerSample
            var interleavedData = Data(count: dataSize)
            
            interleavedData.withUnsafeMutableBytes { (outputPtr: UnsafeMutableRawBufferPointer) in
                guard let outputBuffer = outputPtr.baseAddress?.assumingMemoryBound(to: Int16.self) else {
                    // print("❌ Failed to bind output buffer")
                    return
                }
                
                let audioBufferListPointer = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                
                for channel in 0..<channelCount {
                    guard channel < audioBufferListPointer.count else {
                        // print("⚠️ Channel \(channel) out of bounds")
                        break
                    }
                    
                    guard let channelData = audioBufferListPointer[channel].mData?.assumingMemoryBound(to: Int16.self) else {
                        // print("⚠️ No data for channel \(channel)")
                        continue
                    }
                    
                    for frame in 0..<frameLength {
                        outputBuffer[frame * channelCount + channel] = channelData[frame]
                    }
                }
            }
            
            // print("✅ Interleaved \(interleavedData.count) bytes")
            return interleavedData
        }
    }
    
    deinit {
        if isRecording {
            inputNode?.removeTap(onBus: 0)
            audioEngine?.stop()
        }
    }
}
