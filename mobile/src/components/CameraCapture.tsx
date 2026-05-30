// Full-screen in-app camera for attaching photographic proof to a 911 call.
//
// Flow:  permission gate → live camera (capture / flip / flash) → review the
// shot (retake / use) → downscale + compress to a base64 data URL handed back
// to the caller. The camera surface is intentionally always dark (it sits over
// a live feed), so controls use fixed light-on-dark colors rather than theme
// surfaces; everything else (copy, buttons) uses the design system.
//
// The image is resized to ≤1280px and JPEG-compressed before encoding so the
// payload stays small enough to POST inline and for the backend's vision model
// to read quickly.

import React, { useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, CameraType, FlashMode, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTheme } from '@/theme';
import { Text, Button, Icon, IconBadge } from '@/components/ui';

type Props = {
  visible: boolean;
  onCancel: () => void;
  onCapture: (photoDataUrl: string) => void;
};

// Fixed palette for controls drawn over the live camera feed.
const OVERLAY = 'rgba(8,11,18,0.55)';
const WHITE = '#FFFFFF';

export function CameraCapture({ visible, onCancel, onCapture }: Props) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [shooting, setShooting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null); // file:// uri

  const reset = () => {
    setPreview(null);
    setShooting(false);
    setProcessing(false);
  };

  const close = () => {
    reset();
    onCancel();
  };

  const takeShot = async () => {
    if (!cameraRef.current || shooting) return;
    setShooting(true);
    try {
      const shot = await cameraRef.current.takePictureAsync({ quality: 0.7, skipProcessing: false });
      if (shot?.uri) setPreview(shot.uri);
    } catch {
      /* leave camera live; the user can simply tap again */
    } finally {
      setShooting(false);
    }
  };

  const usePhoto = async () => {
    if (!preview || processing) return;
    setProcessing(true);
    try {
      const out = await ImageManipulator.manipulateAsync(
        preview,
        [{ resize: { width: 1280 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (out.base64) {
        onCapture(`data:image/jpeg;base64,${out.base64}`);
        reset();
      } else {
        setProcessing(false);
      }
    } catch {
      setProcessing(false);
    }
  };

  // ── Permission gate ───────────────────────────────────────────────────────
  const renderPermissionGate = () => (
    <SafeAreaView style={[styles.gate, { backgroundColor: t.color.bg }]} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.gateInner}>
        <IconBadge name="camera" color={t.color.primary} size={72} iconSize={34} />
        <Text variant="h1" center style={{ marginTop: t.spacing.lg }}>
          Add photo proof
        </Text>
        <Text variant="body" tone="secondary" center style={{ marginTop: t.spacing.sm }}>
          {permission && !permission.canAskAgain
            ? 'Camera access is turned off. Enable it in Settings to attach a photo to your 911 call.'
            : 'Sentinel-City needs your camera so you can attach a photo of the emergency. It is sent only to responders handling your call.'}
        </Text>
      </View>
      <View style={{ gap: t.spacing.sm }}>
        <Button
          label="Allow camera"
          variant="primary"
          icon="camera"
          onPress={requestPermission}
          disabled={!!permission && !permission.canAskAgain}
        />
        <Button label="Not now" variant="ghost" onPress={close} />
      </View>
    </SafeAreaView>
  );

  // ── Review captured shot ────────────────────────────────────────────────────
  const renderReview = () => (
    <View style={styles.fill}>
      <Image source={{ uri: preview! }} style={styles.fill} resizeMode="cover" />
      <SafeAreaView style={styles.reviewOverlay} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={[styles.topBar, { paddingHorizontal: t.spacing.lg }]}>
          <View style={[styles.chip, { backgroundColor: OVERLAY }]}>
            <Icon name="check-circle" size={16} color={WHITE} />
            <Text variant="label" color={WHITE}>
              Review your photo
            </Text>
          </View>
        </View>
        <View style={[styles.reviewActions, { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.lg }]}>
          <View style={{ flex: 1 }}>
            <Button label="Retake" variant="secondary" icon="retake" onPress={() => setPreview(null)} disabled={processing} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Use photo" variant="success" icon="check" loading={processing} onPress={usePhoto} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );

  // ── Live camera ─────────────────────────────────────────────────────────────
  const renderCamera = () => (
    <View style={styles.fill}>
      <CameraView ref={cameraRef} style={styles.fill} facing={facing} flash={flash} />
      <SafeAreaView style={styles.cameraOverlay} edges={['top', 'bottom']} pointerEvents="box-none">
        {/* Top bar: close + guidance + flash */}
        <View style={[styles.topBar, { paddingHorizontal: t.spacing.lg }]}>
          <Pressable onPress={close} hitSlop={12} style={[styles.iconBtn, { backgroundColor: OVERLAY }]} accessibilityRole="button" accessibilityLabel="Close camera">
            <Icon name="close" size={24} color={WHITE} />
          </Pressable>
          <View style={[styles.chip, { backgroundColor: OVERLAY }]}>
            <Icon name="shield-check" size={15} color={WHITE} />
            <Text variant="label" color={WHITE} numberOfLines={1}>
              Photo proof for 911
            </Text>
          </View>
          <Pressable
            onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
            hitSlop={12}
            style={[styles.iconBtn, { backgroundColor: OVERLAY }]}
            accessibilityRole="button"
            accessibilityLabel={flash === 'off' ? 'Turn flash on' : 'Turn flash off'}
          >
            <Icon name={flash === 'off' ? 'flash-off' : 'flash'} size={22} color={flash === 'off' ? WHITE : t.color.warning} />
          </Pressable>
        </View>

        {/* Guidance pill */}
        <View style={styles.hintWrap} pointerEvents="none">
          <View style={[styles.hint, { backgroundColor: OVERLAY }]}>
            <Text variant="caption" color={WHITE} center>
              Point at the hazard — fire, flooding, damage, or what you need help with.
            </Text>
          </View>
        </View>

        {/* Bottom: flip + shutter */}
        <View style={[styles.controls, { paddingHorizontal: t.spacing.xxl, paddingBottom: t.spacing.md }]}>
          <Pressable
            onPress={() => setFacing((c) => (c === 'back' ? 'front' : 'back'))}
            hitSlop={12}
            style={[styles.iconBtn, styles.sideBtn, { backgroundColor: OVERLAY }]}
            accessibilityRole="button"
            accessibilityLabel="Flip camera"
          >
            <Icon name="camera-reverse" size={26} color={WHITE} />
          </Pressable>

          <Pressable
            onPress={takeShot}
            disabled={shooting}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={({ pressed }) => [styles.shutterOuter, { borderColor: WHITE, opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.shutterInner, { backgroundColor: shooting ? t.color.textMuted : WHITE }]}>
              {shooting && <ActivityIndicator color={t.color.bg} />}
            </View>
          </Pressable>

          {/* Spacer to balance the flip button so the shutter stays centered. */}
          <View style={styles.sideBtn} />
        </View>
      </SafeAreaView>
    </View>
  );

  let body: React.ReactNode;
  if (!permission) {
    body = (
      <View style={[styles.gate, { backgroundColor: t.color.bg }]}>
        <ActivityIndicator color={t.color.primary} />
      </View>
    );
  } else if (!permission.granted) {
    body = renderPermissionGate();
  } else if (preview) {
    body = renderReview();
  } else {
    body = renderCamera();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={[styles.fill, { backgroundColor: '#000' }]}>{body}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  gate: { flex: 1, padding: 24, justifyContent: 'space-between' },
  gateInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cameraOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  reviewOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, gap: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, flexShrink: 1 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hintWrap: { alignItems: 'center', paddingHorizontal: 32 },
  hint: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, maxWidth: 320 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideBtn: { width: 56, alignItems: 'center' },
  shutterOuter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  reviewActions: { flexDirection: 'row', gap: 12 },
});
